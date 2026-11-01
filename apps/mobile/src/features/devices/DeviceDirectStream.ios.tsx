// @effect-diagnostics globalFetch:off - This view asks for its offer without an Effect runtime.
import {
  type DeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/device/hub-access";
import type { EnvironmentId } from "@t3tools/contracts";
import { requireNativeModule, requireNativeView } from "expo";
import { useEffect, useEffectEvent, useImperativeHandle, useRef, useState, type Ref } from "react";
import { AppState, View, type ViewProps } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { useDeviceHubAccess } from "../../state/device";

import { directStreamOfferFrom, type DirectStreamOffer } from "./directStreamOffer";
import type { DeviceDirectStreamProps } from "./DeviceDirectStream";
import type { DeviceStreamRef } from "./DeviceStreamWebView";

export const supportsDirectStream = true;

type NativeStatus = {
  readonly nativeEvent: { readonly status: string; readonly detail?: string | null };
};
type NativeInput = { readonly nativeEvent: { readonly connected: boolean } };
type NativeHandle = {
  readonly pressButton: (button: string) => Promise<void>;
  readonly rotate: () => Promise<void>;
};

const NativeDirectStream = requireNativeView<
  ViewProps & {
    readonly ref?: Ref<NativeHandle>;
    readonly offer: DirectStreamOffer;
    readonly onStreamStatus: (event: NativeStatus) => void;
    readonly onInputConnected: (event: NativeInput) => void;
  }
>("T3DeviceStream");

const { supportsHEVC } = requireNativeModule<{ readonly supportsHEVC: boolean }>("T3DeviceStream");

async function fetchOffer(access: DeviceHubAccess, deviceId: string, signal: AbortSignal) {
  const response = await fetch(
    withDeviceHubQuery(
      `${access.httpBase}/direct-stream?device=${encodeURIComponent(deviceId)}&codecs=${supportsHEVC ? "hevc,h264" : "h264"}`,
      access,
    ),
    { method: "POST", signal, credentials: access.credentials ? "include" : "same-origin" },
  );
  return response.ok ? directStreamOfferFrom(await response.json()) : null;
}

export function DeviceDirectStream({
  ref,
  environmentId,
  hostId,
  deviceId,
  background,
  onInputConnected,
  onUnavailable,
}: DeviceDirectStreamProps) {
  // Hub tickets are single use, so every offer request needs its own viewer.
  const [attempt, setAttempt] = useState(0);
  const { access, error } = useDeviceHubAccess(
    environmentId as EnvironmentId,
    hostId,
    `direct:${deviceId}:${attempt}`,
  );
  const [offer, setOffer] = useState<DirectStreamOffer | null>(null);
  const [streaming, setStreaming] = useState(false);
  const hasStreamed = useRef(false);
  const native = useRef<NativeHandle>(null);
  const accessKey = access ? JSON.stringify(access) : null;

  const loadOffer = useEffectEvent((signal: AbortSignal) =>
    access ? fetchOffer(access, deviceId, signal) : Promise.resolve(null),
  );
  const unavailable = useEffectEvent(() => onUnavailable());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- each ticket buys one offer, and the WebView stream takes over when there is none
  useEffect(() => {
    if (accessKey === null) return;
    const controller = new AbortController();
    loadOffer(controller.signal).then(
      (received) => {
        if (controller.signal.aborted) return;
        if (received) setOffer(received);
        else unavailable();
      },
      () => {
        if (!controller.signal.aborted) unavailable();
      },
    );
    return () => controller.abort();
  }, [accessKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a suspended app loses its socket and decoder, so returning needs a new session
  useEffect(() => {
    let wasBackground = false;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") wasBackground = true;
      else if (state === "active" && wasBackground) {
        wasBackground = false;
        setOffer(null);
        setStreaming(false);
        setAttempt((current) => current + 1);
      }
    });
    return () => subscription.remove();
  }, []);

  const bridgeInput = useEffectEvent(onInputConnected);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- controls reflect this stream only for as long as it is on screen
  useEffect(() => {
    void bridgeInput(false);
    return () => void bridgeInput(false);
  }, []);

  useImperativeHandle<DeviceStreamRef, DeviceStreamRef>(ref, () => ({
    home: () => void native.current?.pressButton("home"),
    back: () => {},
    appSwitcher: () => void native.current?.pressButton("appSwitcher"),
    rotate: () => void native.current?.rotate(),
  }));

  // The offer never arrives without a ticket, so a ticket that cannot be had also means the WebView.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands over to the WebView stream, which reports its own ticket errors
  useEffect(() => {
    if (error) unavailable();
  }, [error]);

  return (
    <View className="flex-1" style={{ backgroundColor: background }}>
      {offer ? (
        <NativeDirectStream
          key={offer.key}
          ref={native}
          offer={offer}
          style={{ flex: 1 }}
          onStreamStatus={({ nativeEvent }) => {
            if (nativeEvent.status === "streaming") {
              hasStreamed.current = true;
              setStreaming(true);
            } else if (nativeEvent.status === "failed") {
              void onInputConnected(false);
              if (hasStreamed.current) {
                // A stream that worked can come back, as when Wi-Fi drops for a moment.
                hasStreamed.current = false;
                setOffer(null);
                setStreaming(false);
                setAttempt((current) => current + 1);
              } else onUnavailable();
            }
          }}
          onInputConnected={({ nativeEvent }) => void onInputConnected(nativeEvent.connected)}
        />
      ) : null}
      {!streaming ? (
        <View
          pointerEvents="none"
          className="absolute inset-0 items-center justify-center gap-4 px-6"
          style={{ backgroundColor: background }}
        >
          <AppActivityIndicator colorClassName="accent-icon" />
          <AppText className="text-center text-sm text-foreground-muted">
            Connecting to device...
          </AppText>
        </View>
      ) : null}
    </View>
  );
}
