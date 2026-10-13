// The advisor sometimes points at other rows by their input index ("a duplicate
// of item [27]", "items [12] and [25]"). Readers never see those numbers, so
// replace each reference with the tool's name. Document citations such as
// [security-policy.pdf#3] are left alone.

function nameRefs(text, names) {
  if (typeof text !== "string" || !/\[\d+\]/.test(text)) return text;
  const name = (i) => (Number.isInteger(i) && i >= 0 && i < names.length && names[i] ? names[i] : null);
  // "Dropbox Business (item [23])": drop the bracket when the name was just mentioned
  let out = text.replace(/\s*\((?:(?:items?|rows?|entry|entries)\s*)?\[(\d+)\]\)/gi, (m, n, offset, whole) => {
    const label = name(Number(n));
    if (!label) return m;
    return whole.slice(Math.max(0, offset - 80), offset).toLowerCase().includes(label.toLowerCase()) ? "" : ` (${label})`;
  });
  out = out.replace(/\b(?:items?|rows?|entry|entries)\s*\[(\d+)\](\s+)?/gi, (m, n, space, offset, whole) => {
    const label = name(Number(n));
    if (!label) return m;
    // "item [1] Vercel Pro" already names the tool after the number
    const rest = whole.slice(offset + m.length);
    if (rest.toLowerCase().startsWith(label.toLowerCase())) return "";
    return label + (space || "");
  });
  out = out.replace(/\[(\d+)\]/g, (m, n) => name(Number(n)) || m);
  return out;
}

// Apply to every string in the advisor's report
function nameItemRefs(value, names) {
  if (typeof value === "string") return nameRefs(value, names);
  if (Array.isArray(value)) return value.map((v) => nameItemRefs(v, names));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = nameItemRefs(v, names);
    return out;
  }
  return value;
}

module.exports = { nameItemRefs, nameRefs };
