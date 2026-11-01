import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const DirectStreamOffer = Schema.Struct({
  sessionId: Schema.Number,
  key: Schema.String,
  port: Schema.Number,
  addresses: Schema.Array(Schema.String),
});
export type DirectStreamOffer = typeof DirectStreamOffer.Type;

const decode = Schema.decodeUnknownOption(DirectStreamOffer);

/** A server with no addresses has nothing a phone could reach, so it counts as no offer. */
export function directStreamOfferFrom(value: unknown): DirectStreamOffer | null {
  const offer = Option.getOrNull(decode(value));
  return offer && offer.addresses.length > 0 ? offer : null;
}
