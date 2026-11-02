import { describe, expect, it } from "vite-plus/test";

import { directStreamOfferFrom } from "./directStreamOffer";

const offer = { sessionId: 7, key: "a2V5", port: 5000, addresses: ["192.168.1.2"] };

describe("directStreamOfferFrom", () => {
  it("accepts an offer with somewhere to connect", () => {
    expect(directStreamOfferFrom(offer)).toEqual(offer);
  });

  it("accepts a cable as somewhere to connect", () => {
    const cableOnly = { ...offer, addresses: [], usbPort: 47811 };
    expect(directStreamOfferFrom(cableOnly)).toEqual(cableOnly);
  });

  it("rejects malformed offers and offers with nowhere to connect", () => {
    expect(directStreamOfferFrom({ ...offer, addresses: [] })).toBeNull();
    expect(directStreamOfferFrom({ ...offer, usbPort: "47811" })).toBeNull();
    expect(directStreamOfferFrom({ ...offer, port: "5000" })).toBeNull();
    expect(directStreamOfferFrom(null)).toBeNull();
  });
});
