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

let answered = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, bunServer) {
    if (bunServer.upgrade(request)) return undefined;
    return new Response("websocket required", { status: 426 });
  },
  websocket: {
    open(socket) {
      socket.send(
        JSON.stringify({
          event: "signal/provide",
          id: "fixture-client",
          lite: true,
          ice: [],
          sdp: offer,
        }),
      );
    },
    message(_socket, message) {
      const value = JSON.parse(message.toString()) as { event?: string };
      if (value.event === "signal/answer") answered = true;
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

process.stdout.write(`${JSON.stringify({ answered, closed: true, status })}\n`);
