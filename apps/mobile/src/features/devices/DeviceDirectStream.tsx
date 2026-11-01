import type { DeviceStreamRef } from "./DeviceStreamWebView";
import type { Ref } from "react";

export const supportsDirectStream = false;

export interface DeviceDirectStreamProps {
  readonly ref?: Ref<DeviceStreamRef>;
  readonly environmentId: string;
  readonly hostId: string;
  readonly deviceId: string;
  readonly background: string;
  readonly onInputConnected: (connected: boolean) => Promise<void>;
  /** Nothing can reach the host directly, so the caller should use the WebView stream. */
  readonly onUnavailable: () => void;
}

/** The native stream exists only on iOS; see DeviceDirectStream.ios.tsx. */
export function DeviceDirectStream(_props: DeviceDirectStreamProps) {
  return null;
}
