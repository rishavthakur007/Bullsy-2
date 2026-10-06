/* Minimal protobuf reader for Upstox Market Data Feed V3 (FeedResponse).
   Field numbers follow Upstox's published MarketDataFeedV3.proto. Only the
   fields Bullsy needs are named; everything else is skipped safely. */
const D = 'double', I = 'int64', S = 'string';
const TYPE = ['initial_feed', 'live_feed', 'market_info'];
const MARKET_STATUS = ['PRE_OPEN_START', 'PRE_OPEN_END', 'NORMAL_OPEN', 'NORMAL_CLOSE', 'CLOSING_START', 'CLOSING_END'];
const REQUEST_MODE = ['ltpc', 'full_d5', 'option_greeks', 'full_d30'];
const en = names => ({ enum: names });

const LTPC = { 1: ['ltp', D], 2: ['ltt', I], 3: ['ltq', I], 4: ['cp', D] };
const OHLC = { 1: ['interval', S], 2: ['open', D], 3: ['high', D], 4: ['low', D], 5: ['close', D], 6: ['vol', I], 7: ['ts', I] };
const MarketOHLC = { 1: ['ohlc', OHLC, 'repeated'] };
const IndexFullFeed = { 1: ['ltpc', LTPC], 2: ['marketOHLC', MarketOHLC] };
const MarketFullFeed = { 1: ['ltpc', LTPC], 4: ['marketOHLC', MarketOHLC] };
const FullFeed = { 1: ['marketFF', MarketFullFeed], 2: ['indexFF', IndexFullFeed] };
const FirstLevelWithGreeks = { 1: ['ltpc', LTPC] };
const Feed = { 1: ['ltpc', LTPC], 2: ['fullFeed', FullFeed], 3: ['firstLevelWithGreeks', FirstLevelWithGreeks], 4: ['requestMode', en(REQUEST_MODE)] };
const MarketInfo = { 1: ['segmentStatus', en(MARKET_STATUS), 'map'] };
export const FeedResponse = { 1: ['type', en(TYPE)], 2: ['feeds', Feed, 'map'], 3: ['currentTs', I], 4: ['marketInfo', MarketInfo] };

function varint(buf, pos) {
  let result = 0n, shift = 0n, b;
  do {
    if (pos >= buf.length) throw new Error('protobuf: truncated varint');
    b = buf[pos++]; result |= BigInt(b & 0x7f) << shift; shift += 7n;
  } while (b & 0x80);
  return [result, pos];
}
function value(type, wire, buf, pos, end) {
  if (wire === 0) {
    const [v, p] = varint(buf, pos);
    if (type && type.enum) return [type.enum[Number(v)] ?? Number(v), p];
    return [Number(BigInt.asIntN(64, v)), p];
  }
  if (wire === 1) return [new DataView(buf.buffer, buf.byteOffset + pos, 8).getFloat64(0, true), pos + 8];
  if (wire === 5) return [new DataView(buf.buffer, buf.byteOffset + pos, 4).getFloat32(0, true), pos + 4];
  if (wire === 2) {
    const [len, p] = varint(buf, pos), stop = p + Number(len);
    if (stop > end) throw new Error('protobuf: truncated field');
    const slice = buf.subarray(p, stop);
    if (type === S) return [new TextDecoder().decode(slice), stop];
    if (type && typeof type === 'object' && !type.enum) return [decode(slice, type), stop];
    return [undefined, stop];
  }
  throw new Error('protobuf: unsupported wire type ' + wire);
}
export function decode(buf, schema = FeedResponse) {
  const out = {}; let pos = 0; const end = buf.length;
  while (pos < end) {
    const [tag, p] = varint(buf, pos); pos = p;
    const field = Number(tag >> 3n), wire = Number(tag & 7n), def = schema[field];
    if (!def) { [, pos] = value(null, wire, buf, pos, end); continue; }
    const [name, type, kind] = def;
    if (kind === 'map') {
      const [len, q] = varint(buf, pos), stop = q + Number(len); let ep = q, k = '', v;
      while (ep < stop) {
        const [etag, e2] = varint(buf, ep); const ef = Number(etag >> 3n), ew = Number(etag & 7n);
        if (ef === 1) [k, ep] = value(S, ew, buf, e2, stop);
        else if (ef === 2) [v, ep] = value(type, ew, buf, e2, stop);
        else [, ep] = value(null, ew, buf, e2, stop);
      }
      (out[name] ||= {})[k] = v; pos = stop;
    } else {
      let v; [v, pos] = value(type, wire, buf, pos, end);
      if (kind === 'repeated') (out[name] ||= []).push(v); else out[name] = v;
    }
  }
  return out;
}
