export async function fetchQuotas(): Promise<any[]> {
  const r = await fetch("/api/quotas");
  return r.json();
}
export async function fetchRecommendation(): Promise<any> {
  const r = await fetch("/api/recommendation");
  return r.json();
}
