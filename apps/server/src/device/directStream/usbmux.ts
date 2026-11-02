// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - usbmuxd speaks its own framing over a unix socket, for a session outside the Effect runtime.
/**
 * A minimal usbmuxd client: finds iPhones attached by cable and opens a TCP connection to a port on
 * one, the way Xcode reaches a device. The direct stream uses it so a phone on a cable needs no Wi-Fi.
 * Messages are `u32 length | u32 version | u32 type | u32 tag` little endian, then an XML plist.
 */
import * as NodeNet from "node:net";

const USBMUXD_SOCKET = "/var/run/usbmuxd";
const HEADER_BYTES = 16;
const PLIST_VERSION = 1;
const PLIST_MESSAGE = 8;
const REQUEST_TIMEOUT_MS = 1_000;

type PlistValue =
  | string
  | number
  | boolean
  | ReadonlyArray<PlistValue>
  | { readonly [key: string]: PlistValue };

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const unescapeXml = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

function encodeRequest(entries: Readonly<Record<string, string | number>>): Buffer {
  const fields = Object.entries({ ClientVersionString: "t3code", ProgName: "t3code", ...entries })
    .map(([key, value]) =>
      typeof value === "number"
        ? `<key>${key}</key><integer>${value}</integer>`
        : `<key>${key}</key><string>${escapeXml(value)}</string>`,
    )
    .join("");
  const body = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${fields}</dict></plist>`,
  );
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(HEADER_BYTES + body.length, 0);
  header.writeUInt32LE(PLIST_VERSION, 4);
  header.writeUInt32LE(PLIST_MESSAGE, 8);
  header.writeUInt32LE(1, 12);
  return Buffer.concat([header, body]);
}

/** Enough of XML plists for usbmuxd's replies: dicts, arrays, strings, numbers and booleans. */
export function parsePlist(xml: string): PlistValue | null {
  const tokens = [...xml.matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>|([^<]+)/g)];
  let cursor = 0;
  const text = () => {
    const token = tokens[cursor];
    if (token?.[4] === undefined) return "";
    cursor++;
    return unescapeXml(token[4]);
  };
  const close = () => cursor++;
  const value = (): PlistValue | null => {
    while (cursor < tokens.length && tokens[cursor]![4] !== undefined) cursor++;
    const token = tokens[cursor++];
    if (!token || token[1]) return null;
    const name = token[2]!;
    const selfClosing = token[3] === "/";
    switch (name) {
      case "plist":
        return value();
      case "true":
      case "false":
        if (!selfClosing) close();
        return name === "true";
      case "string":
      case "data":
      case "date": {
        if (selfClosing) return "";
        const content = text();
        close();
        return content;
      }
      case "integer":
      case "real": {
        const content = text();
        close();
        return Number(content.trim());
      }
      case "array": {
        const items: Array<PlistValue> = [];
        if (selfClosing) return items;
        for (;;) {
          while (cursor < tokens.length && tokens[cursor]![4] !== undefined) cursor++;
          if (cursor >= tokens.length) return null;
          if (tokens[cursor]![1] === "/") {
            close();
            return items;
          }
          const item = value();
          if (item === null) return null;
          items.push(item);
        }
      }
      case "dict": {
        const entries: Record<string, PlistValue> = {};
        if (selfClosing) return entries;
        for (;;) {
          while (cursor < tokens.length && tokens[cursor]![4] !== undefined) cursor++;
          const token = tokens[cursor];
          if (!token) return null;
          if (token[1] === "/") {
            close();
            return entries;
          }
          if (token[2] !== "key") return null;
          cursor++;
          const key = text();
          close();
          const entry = value();
          if (entry === null) return null;
          entries[key] = entry;
        }
      }
      default:
        return null;
    }
  };
  const start = tokens.findIndex((token) => token[2] === "plist" && !token[1]);
  if (start < 0) return null;
  cursor = start;
  return value();
}

/**
 * Sends one request on a fresh connection and resolves with its reply. The socket stays open and
 * paused, with anything after the reply pushed back: after a Connect, that is the device talking.
 */
function request(
  socketPath: string,
  entries: Readonly<Record<string, string | number>>,
): Promise<{ readonly socket: NodeNet.Socket; readonly reply: PlistValue } | null> {
  return new Promise((resolve) => {
    const socket = NodeNet.connect(socketPath);
    let received = Buffer.alloc(0);
    let done = false;
    const finish = (reply: PlistValue | null, rest?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.pause();
      socket.off("data", onData);
      socket.off("error", onError);
      if (reply === null) {
        socket.destroy();
        return resolve(null);
      }
      // The caller listens for close; an error is only ever followed by one.
      socket.on("error", () => {});
      if (rest && rest.length > 0) socket.unshift(rest);
      resolve({ socket, reply });
    };
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < HEADER_BYTES) return;
      const length = received.readUInt32LE(0);
      if (length < HEADER_BYTES) return finish(null);
      if (received.length < length) return;
      finish(
        parsePlist(received.subarray(HEADER_BYTES, length).toString("utf8")),
        received.subarray(length),
      );
    };
    const onError = () => finish(null);
    const timer = setTimeout(() => finish(null), REQUEST_TIMEOUT_MS);
    socket.once("connect", () => socket.write(encodeRequest(entries)));
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

const field = (value: PlistValue | undefined, key: string): PlistValue | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, PlistValue>)[key]
    : undefined;

/** usbmuxd's ids of the devices attached by cable; network-paired ones would only go over Wi-Fi. */
export async function listUsbDevices(socketPath = USBMUXD_SOCKET): Promise<ReadonlyArray<number>> {
  const answer = await request(socketPath, { MessageType: "ListDevices" });
  if (!answer) return [];
  answer.socket.destroy();
  const devices = field(answer.reply, "DeviceList");
  if (!Array.isArray(devices)) return [];
  const ids: Array<number> = [];
  for (const device of devices) {
    const properties = field(device, "Properties");
    const id = field(properties, "DeviceID");
    if (field(properties, "ConnectionType") === "USB" && typeof id === "number") ids.push(id);
  }
  return ids;
}

/** A raw connection to `port` on the device, paused until the caller listens; null when nothing listens there. */
async function connectUsbDevice(
  deviceId: number,
  port: number,
  socketPath = USBMUXD_SOCKET,
): Promise<NodeNet.Socket | null> {
  const answer = await request(socketPath, {
    MessageType: "Connect",
    DeviceID: deviceId,
    // usbmuxd wants the port in network byte order, read as a little endian integer.
    PortNumber: ((port & 0xff) << 8) | ((port >> 8) & 0xff),
  });
  if (!answer) return null;
  if (field(answer.reply, "Number") !== 0) {
    answer.socket.destroy();
    return null;
  }
  return answer.socket;
}

/** Connections to `port` on every phone on a cable that is listening there. */
export async function connectAttachedPhones(
  port: number,
  socketPath = USBMUXD_SOCKET,
): Promise<ReadonlyArray<NodeNet.Socket>> {
  const devices = await listUsbDevices(socketPath);
  const sockets = await Promise.all(devices.map((id) => connectUsbDevice(id, port, socketPath)));
  return sockets.filter((socket): socket is NodeNet.Socket => socket !== null);
}
