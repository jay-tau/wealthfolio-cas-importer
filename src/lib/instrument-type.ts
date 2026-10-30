// Wealthfolio stores canonical types, while remembered provider results can use aliases.
export const instrumentType = (value: string) => {
  const type = value.trim().toUpperCase();
  if (/^(STOCK|ETF|MUTUAL[_ ]?FUND|INDEX|ECNQUOTE|FUTURES?)$/.test(type)) return "EQUITY";
  if (type === "CRYPTOCURRENCY") return "CRYPTO";
  if (/^(FOREX|CURRENCY)$/.test(type)) return "FX";
  if (type === "COMMODITY") return "METAL";
  if (/^(FIXED_?INCOME|DEBT|MONEYMARKET)$/.test(type)) return "BOND";
  return type;
};
