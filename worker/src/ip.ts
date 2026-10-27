/** The rate-limit key for a client address: IPv4 as is, IPv6 by its /64, since one
 * client usually holds a whole /64 and could otherwise rotate through it. */
export function ipKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  // IPv4-mapped (::ffff:1.2.3.4): the IPv4 address it carries.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = ip.includes("::") && tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}
