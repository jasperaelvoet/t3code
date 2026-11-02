import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const DirectStreamOffer = Schema.Struct({
  sessionId: Schema.Number,
  key: Schema.String,
  port: Schema.Number,
  addresses: Schema.Array(Schema.String),
  /** Where to listen for the host over a cable, when it can reach this phone that way. */
  usbPort: Schema.optional(Schema.Number),
});
export type DirectStreamOffer = typeof DirectStreamOffer.Type;

const decode = Schema.decodeUnknownOption(DirectStreamOffer);

/** A server with no addresses and no cable has nothing a phone could reach, so it counts as no offer. */
export function directStreamOfferFrom(value: unknown): DirectStreamOffer | null {
  const offer = Option.getOrNull(decode(value));
  return offer && (offer.addresses.length > 0 || offer.usbPort !== undefined) ? offer : null;
}
