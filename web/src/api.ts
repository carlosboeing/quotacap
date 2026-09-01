export async function fetchQuotas(): Promise<any[]> {
  const r = await fetch("/api/quotas");
  return r.json();
}
export async function fetchRecommendation(): Promise<any> {
  const r = await fetch("/api/recommendation");
  return r.json();
}
export async function fetchToken(): Promise<string> {
  const r = await fetch("/api/token");
  const data = await r.json();
  return data.token;
}
export async function refreshQuotas(): Promise<any> {
  const token = await fetchToken();
  const r = await fetch("/api/refresh", {
    method: "POST",
    headers: {
      "X-QuotaCap-Token": token,
    },
  });
  return r.json();
}
