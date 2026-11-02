// @effect-diagnostics nodeBuiltinImport:off - Talks to a fake usbmuxd on a real unix socket.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { connectAttachedPhones, listUsbDevices, parsePlist } from "./usbmux.ts";

function reply(xml: string, after = Buffer.alloc(0)) {
  const body = Buffer.from(xml);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(16 + body.length, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(8, 8);
  header.writeUInt32LE(1, 12);
  return Buffer.concat([header, body, after]);
}

const plist = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${inner}</plist>`;

const DEVICE_LIST = plist(`<dict><key>DeviceList</key><array>
  <dict><key>DeviceID</key><integer>7</integer><key>MessageType</key><string>Attached</string>
    <key>Properties</key><dict><key>ConnectionType</key><string>USB</string><key>DeviceID</key><integer>7</integer>
    <key>SerialNumber</key><string>00008130-0001</string><key>USBSerialNumber</key><string>a&amp;b</string></dict></dict>
  <dict><key>DeviceID</key><integer>9</integer><key>MessageType</key><string>Attached</string>
    <key>Properties</key><dict><key>ConnectionType</key><string>Network</string><key>DeviceID</key><integer>9</integer>
    <key>EscapedFullServiceName</key><string>x</string><key>InterfaceIndex</key><integer>12</integer></dict></dict>
  <dict><key>DeviceID</key><integer>11</integer><key>MessageType</key><string>Attached</string>
    <key>Properties</key><dict><key>ConnectionType</key><string>USB</string><key>DeviceID</key><integer>11</integer>
    <key>Paired</key><true/></dict></dict>
</array></dict>`);

const result = (number: number) =>
  plist(
    `<dict><key>MessageType</key><string>Result</string><key>Number</key><integer>${number}</integer></dict>`,
  );

/** usbmuxd with phone 7 listening on the requested port and phone 11 refusing it. */
async function fakeUsbmuxd() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "usbmuxd-"));
  const socketPath = NodePath.join(directory, "usbmuxd");
  const requests: Array<string> = [];
  const server = NodeNet.createServer((client) => {
    let received = Buffer.alloc(0);
    const onRequest = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 16 || received.length < received.readUInt32LE(0)) return;
      // One request a connection; after a Connect, the bytes are the phone's.
      client.off("data", onRequest);
      const body = received.subarray(16, received.readUInt32LE(0)).toString();
      requests.push(body);
      if (body.includes("<string>ListDevices</string>")) client.end(reply(DEVICE_LIST));
      else if (body.includes("<integer>7</integer>")) {
        // The phone speaks at once, so its first bytes arrive with usbmuxd's answer.
        client.write(reply(result(0), Buffer.from("hello from phone")));
        client.on("data", (echo: Buffer) => client.write(echo));
      } else client.end(reply(result(3)));
    };
    client.on("data", onRequest);
  });
  await new Promise<void>((listening) => server.listen(socketPath, listening));
  return {
    socketPath,
    requests,
    close: () => {
      server.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function readUntil(socket: NodeNet.Socket, expected: string) {
  return new Promise<string>((resolve) => {
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes(expected)) resolve(text);
    });
    socket.resume();
  });
}

describe("usbmux", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("parses the parts of XML plists usbmuxd sends", () => {
    expect(
      parsePlist(
        plist(
          "<dict><key>a</key><array><integer>-3</integer><true/><string>x &lt; y</string><string></string></array><key>b</key><dict/></dict>",
        ),
      ),
    ).toEqual({ a: [-3, true, "x < y", ""], b: {} });
    expect(parsePlist("not a plist")).toBeNull();
  });

  it("lists only the phones on a cable", async () => {
    const usbmuxd = await fakeUsbmuxd();
    cleanups.push(usbmuxd.close);
    expect(await listUsbDevices(usbmuxd.socketPath)).toEqual([7, 11]);
  });

  it("connects to the phones listening on the port, keeping what they said first", async () => {
    const usbmuxd = await fakeUsbmuxd();
    cleanups.push(usbmuxd.close);
    const sockets = await connectAttachedPhones(47_811, usbmuxd.socketPath);
    expect(sockets).toHaveLength(1);
    const phone = sockets[0]!;
    cleanups.push(() => phone.destroy());
    // 47811 is 0xbac3, which usbmuxd expects byte swapped.
    expect(
      usbmuxd.requests.filter((body) => body.includes("<integer>50106</integer>")),
    ).toHaveLength(2);
    const heard = readUntil(phone, "ping");
    phone.write("ping");
    expect(await heard).toBe("hello from phoneping");
  });

  it("finds nothing when usbmuxd is not running", async () => {
    const missing = NodePath.join(NodeOS.tmpdir(), "no-usbmuxd-here");
    expect(await connectAttachedPhones(47_811, missing)).toEqual([]);
  });
});
