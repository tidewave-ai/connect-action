# Tidewave Connect Action

Runs [Tidewave Connect](https://tidewave.ai) for your web app inside a GitHub Actions job, so coding agents in later steps (such as [Claude Code](https://github.com/anthropics/claude-code-action)) can use all Tidewave features through MCP, including the browser: evaluating code in your app's pages, taking screenshots and recording videos.

The action opens Tidewave Connect in a headed Chromium browser (on Xvfb on Linux), signs it in with your Tidewave API key, waits until it is ready and leaves the browser running for the rest of the job.

## Requirements

- Your app has Tidewave installed and enabled in the environment it runs in on CI.
- Your app is started in an earlier step, in the background. It may still be booting when the action starts; the action waits for it.
- A Tidewave API key, created in your [account settings](https://tidewave.ai/settings) (requires a subscription) or in your team settings (uses the team subscription). Store it as a repository secret, such as `TIDEWAVE_API_KEY`.

On GitHub-hosted Ubuntu runners, the action uses the preinstalled Google Chrome and Xvfb. Elsewhere, it installs Chromium and its system dependencies through Playwright, which requires `npm` and, on Linux, `sudo`.

## Usage

The following workflow runs Claude Code against a Phoenix app whenever an issue or a pull request is labeled `tidewave`:

```yaml
name: Tidewave

on:
  issues:
    types: [labeled]
  pull_request:
    types: [labeled]

jobs:
  tidewave:
    if: github.event.label.name == 'tidewave'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v5
        with:
          # For pull requests, work on the pull request branch.
          ref: ${{ github.head_ref }}

      # Set up your app as usual, such as installing Elixir and
      # dependencies, and starting the database.

      - name: Start the app
        run: mix phx.server > app.log 2>&1 &

      - uses: tidewave-ai/connect-action@v1
        id: tidewave
        with:
          app_url: http://localhost:4000
          api_key: ${{ secrets.TIDEWAVE_API_KEY }}

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Work on ${{ github.event.issue && 'issue' || 'pull request' }} #${{ github.event.issue.number || github.event.pull_request.number }}: ${{ github.event.issue.title || github.event.pull_request.title }}

            ${{ github.event.issue.body || github.event.pull_request.body }}

            Use the Tidewave tools to evaluate code in the app and to verify your changes in the browser.
          claude_args: |
            --mcp-config '{"mcpServers": {"tidewave": {"type": "http", "url": "${{ steps.tidewave.outputs.mcp_url }}"}}}'
            --allowedTools "mcp__tidewave"
```

See the [Claude Code Action docs](https://github.com/anthropics/claude-code-action) for configuring how Claude reports back, such as opening pull requests.

Note that GitHub does not pass secrets to workflows for pull requests from forks, so the action only runs for pull requests from branches of your repository.

## Inputs

| Name            | Required | Default               | Description                                                                                    |
| --------------- | -------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `app_url`       | Yes      |                       | The URL of your web app, such as `http://localhost:4000`.                                      |
| `api_key`       | Yes      |                       | Your Tidewave API key. Pass it from a secret.                                                  |
| `max_wait_time` | No       | `300`                 | Maximum time in seconds to wait for the app to boot and for Tidewave Connect to be ready.     |

## Outputs

| Name       | Description                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `mcp_url`  | The URL of the Tidewave MCP server in your app, to configure your coding agent with.              |
| `log_file` | The path to the browser log, with console messages from Tidewave Connect and your app.            |

At the end of the job, the action prints the browser log and stops the browser. To keep the full log, upload `log_file` with `actions/upload-artifact`.

## Security

The API key never reaches the browser. The action exchanges it for a token that is valid for one day and that can only be used by Tidewave Connect. Deleting the API key in your Tidewave settings revokes such tokens immediately.

Keep in mind that the coding agent controls your app's pages, so it can read the token. When running on issues from untrusted users, which may contain instructions targeting the agent, consider restricting who can trigger the workflow.
