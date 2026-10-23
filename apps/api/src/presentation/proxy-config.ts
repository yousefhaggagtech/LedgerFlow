import { isIP } from "node:net";

const MAX_PROXY_HOPS = 16;
const MAX_PROXY_NETWORKS = 32;
export type TrustProxy = false | number | string[];

export function loadTrustProxy(env: NodeJS.ProcessEnv = process.env): TrustProxy {
  const value = env.TRUST_PROXY?.trim();
  if (!value) return false;
  if (/^(0|[1-9][0-9]*)$/.test(value)) {
    const hops = Number(value);
    if (hops <= MAX_PROXY_HOPS) return hops === 0 ? false : hops;
  } else {
    const networks = value.split(",").map((network) => network.trim());
    if (networks.length <= MAX_PROXY_NETWORKS && networks.every((network) => {
      const [address, prefix, extra] = network.split("/");
      if (!address || !prefix || extra !== undefined || !/^[1-9][0-9]*$/.test(prefix)) return false;
      const version = isIP(address);
      return version !== 0 && Number(prefix) <= (version === 4 ? 32 : 128);
    })) return networks;
  }
  throw new Error("TRUST_PROXY must be 0–16 proxy hops or explicit IPv4/IPv6 CIDRs with nonzero masks; unrestricted proxy trust is forbidden.");
}
