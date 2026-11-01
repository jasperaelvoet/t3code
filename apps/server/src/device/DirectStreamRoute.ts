// Starts direct device streams. The route only hands out an offer: the viewer proves itself to the
// UDP socket with the offer's key, which it can only get from here, over the environment connection.
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as DeviceService from "./DeviceService.ts";
import { DirectStreamSession } from "./directStream/DirectStreamSession.ts";

const DIRECT_STREAM_PATH = `${DeviceService.DEVICE_HUB_ROUTE_PREFIX}/direct-stream`;

const SIMULATOR_UDID = /^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;

const handler = Effect.fn("DirectStreamRoute.handler")(function* (
  sessions: Map<string, DirectStreamSession>,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  // It drives the device as well as showing it, so it takes the same scope as the input socket.
  yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
  const deviceId = url.value.searchParams.get("device");
  if (!deviceId || !SIMULATOR_UDID.test(deviceId)) {
    return HttpServerResponse.text("Unknown device", { status: 400 });
  }
  const hostId = url.value.searchParams.get("hostId") ?? undefined;
  const devices = yield* DeviceService.DeviceService;
  const ready = yield* devices.currentReadiness(hostId);
  if (!ready) return HttpServerResponse.text("Device hub is not running", { status: 503 });
  // A cloud host's simulator is not on this machine, so UDP from here would add a hop, not remove one.
  if (ready.upstream) {
    return HttpServerResponse.text("This host cannot stream directly", { status: 409 });
  }
  const sessionKey = `${hostId ?? ""}:${deviceId}`;
  sessions.get(sessionKey)?.stop("replaced by a new viewer");
  const session: DirectStreamSession = new DirectStreamSession({
    hubOrigin: ready.hub.origin,
    deviceId,
    onEnd: () => {
      if (sessions.get(sessionKey) === session) sessions.delete(sessionKey);
    },
  });
  sessions.set(sessionKey, session);
  const offer = yield* Effect.tryPromise(() => session.start()).pipe(Effect.option);
  if (Option.isNone(offer)) {
    session.stop("could not start");
    return HttpServerResponse.text("Could not open a stream socket", { status: 500 });
  }
  return yield* HttpServerResponse.json(offer.value);
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const sessions = new Map<string, DirectStreamSession>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const session of sessions.values()) session.stop("server stopping");
      }),
    );
    return HttpRouter.add("POST", DIRECT_STREAM_PATH, handler(sessions));
  }),
);
