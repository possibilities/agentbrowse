import { connectionDescriptor } from "../../client/connection.ts";
import { NativeLiveViewSession } from "../../src/opentui/native.ts";

const libraryPath = process.argv[2];
if (!libraryPath) throw new Error("missing ABI v2 library path");

const session = NativeLiveViewSession.create(
  connectionDescriptor({ name: "abi-v2-comparison" }, "http://127.0.0.1:9"),
  libraryPath,
);
try {
  process.stdout.write(JSON.stringify({ input: session.metrics().input }));
} finally {
  session.close();
}
