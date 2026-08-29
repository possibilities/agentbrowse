import { connectionDescriptor } from "../../client/connection.ts";
import { NativeLiveViewSession } from "../../src/opentui/native.ts";

const offer = `${[
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0 1",
  "a=msid-semantic: WMS stream",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "c=IN IP4 0.0.0.0",
  "a=rtcp:9 IN IP4 0.0.0.0",
  "a=ice-ufrag:test",
  "a=ice-pwd:0123456789012345678901",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
  "a=setup:actpass",
  "a=mid:0",
  "a=sendonly",
  "a=msid:stream video",
  "a=rtcp-mux",
  "a=rtpmap:96 VP8/90000",
  "a=ssrc:1 cname:test",
  "a=ssrc:1 msid:stream video",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=ice-ufrag:test",
  "a=ice-pwd:0123456789012345678901",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
  "a=setup:actpass",
  "a=mid:1",
  "a=sctp-port:5000",
  "a=max-message-size:262144",
].join("\r\n")}\r\n`;

const token = "fixture-token";
let loginAccepted = false;
let websocketAuthorized = false;
let selectedMain = false;
let candidateSent = false;
let answered = false;
let answerUsesPayload = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, bunServer) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/login") {
      const credentials = (await request.json()) as { username?: string; password?: string };
      loginAccepted = credentials.username === "kernel" && credentials.password === "admin";
      return Response.json({ id: "fixture-client", token, profile: {}, state: {} });
    }
    if (request.method === "POST" && url.pathname === "/api/logout") {
      return Response.json(true);
    }
    if (
      url.pathname === "/api/ws" &&
      url.searchParams.get("token") === token &&
      bunServer.upgrade(request)
    ) {
      websocketAuthorized = true;
      return undefined;
    }
    return new Response("websocket required", { status: 426 });
  },
  websocket: {
    open(socket) {
      socket.send(
        JSON.stringify({
          event: "system/init",
          payload: {
            session_id: "fixture-client",
            settings: { heartbeat_interval: 0, implicit_hosting: true },
            control_host: { has_host: false },
          },
        }),
      );
    },
    message(socket, message) {
      const value = JSON.parse(message.toString()) as {
        event?: string;
        payload?: {
          sdp?: string;
          video?: { selector?: { type?: string; id?: string; bitrate?: number } };
          audio?: { disabled?: boolean };
        };
      };
      if (value.event === "signal/request") {
        selectedMain =
          value.payload?.video?.selector?.type === "exact" &&
          value.payload.video.selector.id === "main" &&
          value.payload.video.selector.bitrate === 0 &&
          value.payload.audio?.disabled === false;
        socket.send(
          JSON.stringify({
            event: "signal/provide",
            payload: { iceservers: [], sdp: offer },
          }),
        );
        // Neko trickles candidates immediately; this deliberately races the
        // asynchronous setRemoteDescription completion in the native client.
        socket.send(
          JSON.stringify({
            event: "signal/candidate",
            payload: {
              candidate: "candidate:0 1 UDP 2122252543 127.0.0.1 54321 typ host",
              sdpMid: "0",
              sdpMLineIndex: 0,
            },
          }),
        );
        candidateSent = true;
      }
      if (value.event === "signal/answer") {
        answered = true;
        answerUsesPayload = typeof value.payload?.sdp === "string";
      }
    },
  },
});

const session = NativeLiveViewSession.create(
  connectionDescriptor({ name: "negotiation-fixture" }, `http://127.0.0.1:${server.port}`),
);
let status = "";
try {
  session.connect();
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    status = session.status();
    if (answered || status === "Native transport error") break;
    await Bun.sleep(10);
  }
  await Bun.sleep(100);
} finally {
  session.close();
  await server.stop(true);
}

process.stdout.write(
  `${JSON.stringify({
    loginAccepted,
    websocketAuthorized,
    selectedMain,
    candidateSent,
    answered,
    answerUsesPayload,
    closed: true,
    status,
  })}\n`,
);
