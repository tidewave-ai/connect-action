// A mock of both the Tidewave server and an app serving Tidewave
// Connect, to test the action without either.
//
// The fake Connect page reports ready when it receives the expected
// token, then sends heartbeats, so we can check that the browser keeps
// running after the action step. When asked to enable vision mode, it
// tries tab capture, which Tidewave uses for screenshots and recordings.
//
// Like the real Connect page, it embeds the app in a same-origin frame,
// and the app may embed third-party frames. Both report whether they
// see the token, which only the Connect page itself should.

import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4100);
// Simulates an app that is still booting.
const bootDelay = Number(process.env.BOOT_DELAY ?? 3_000);
const startedAt = Date.now();

const state = { lastHeartbeatAt: null, capture: null, frames: {} };

// Like the real Connect page, the page loads the client from the
// Tidewave server, which the action uses to find the server URL.
const connectPage = `<!doctype html>
<html>
  <head>
    <script type="module" src="http://localhost:${port}/tc/control.js"></script>
  </head>
  <body>
    <iframe src="/app"></iframe>
    <iframe src="http://127.0.0.1:${port}/third-party"></iframe>
  </body>
</html>`;

function framePage(name) {
  return `<!doctype html>
<html>
  <body>
    <script>
      fetch("/frame", {
        method: "POST",
        body: JSON.stringify({
          name: "${name}",
          hasToken: "TIDEWAVE_AUTH_TOKEN" in window,
        }),
      });
    </script>
  </body>
</html>`;
}

const controlJs = `
if (window.TIDEWAVE_AUTH_TOKEN === "test-token") {
  document.documentElement.dataset.tidewaveConnect = "connecting";

  setTimeout(() => {
    document.documentElement.dataset.tidewaveConnect = "ready";
  }, 500);

  setInterval(() => fetch("/heartbeat", { method: "POST" }), 1000);

  if (window.TIDEWAVE_ENABLE_VISION_MODE === true) {
    navigator.mediaDevices
      .getDisplayMedia({ preferCurrentTab: true })
      .then(() => ({ ok: true }))
      .catch((error) => ({ ok: false, error: String(error) }))
      .then((result) =>
        fetch("/capture", { method: "POST", body: JSON.stringify(result) }),
      );
  }
} else {
  document.body.textContent = "Not authenticated";
}
`;

const server = createServer(async (request, response) => {
  const route = `${request.method} ${new URL(request.url, "http://localhost").pathname}`;

  switch (route) {
    case "POST /api/api-key-exchange":
      return exchange(request, response);

    case "GET /tidewave/connect":
      if (Date.now() - startedAt < bootDelay) {
        return send(response, 503, "text/plain", "Booting");
      }

      return send(response, 200, "text/html", connectPage);

    case "GET /tc/control.js":
      return send(response, 200, "text/javascript", controlJs);

    case "GET /app":
      return send(response, 200, "text/html", framePage("app"));

    case "GET /third-party":
      return send(response, 200, "text/html", framePage("third-party"));

    case "POST /frame": {
      const { name, hasToken } = JSON.parse(await readBody(request));
      state.frames[name] = hasToken;
      return send(response, 204);
    }

    case "POST /heartbeat":
      state.lastHeartbeatAt = Date.now();
      return send(response, 204);

    case "POST /capture":
      state.capture = JSON.parse(await readBody(request));
      return send(response, 204);

    case "GET /status":
      return json(response, 200, state);

    default:
      return send(response, 404, "text/plain", "Not found");
  }
});

server.listen(port, () => {
  console.log(`Mock server listening on http://localhost:${port}`);
});

function exchange(request, response) {
  switch (request.headers.authorization) {
    case "Bearer tw_test":
      return json(response, 200, { token: "test-token" });

    case "Bearer tw_unsubscribed":
      return json(response, 403, {
        error: { message: "Subscription required", type: "subscription_required" },
      });

    default:
      return json(response, 403, {
        error: { message: "Invalid API key", type: "invalid_api_key" },
      });
  }
}

function json(response, status, body) {
  send(response, status, "application/json", JSON.stringify(body));
}

function send(response, status, contentType, body) {
  if (contentType) response.setHeader("content-type", contentType);
  response.writeHead(status);
  response.end(body);
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}
