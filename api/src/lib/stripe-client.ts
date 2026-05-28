// Tiny Stripe REST client. We only need three reads — customers by
// email, subscriptions by customer, charges by customer — so pulling
// in the `stripe` SDK would be heavy for the benefit. Direct fetch
// with the API key as Bearer auth, query params for filtering.
//
// All three calls happen in parallel after the initial customer search;
// total wall time is ~one Stripe round-trip (~150ms) + the parallel
// fan-out.

const STRIPE_BASE = 'https://api.stripe.com/v1';

interface StripeCustomer {
  id:    string;
  email: string;
  name?: string;
  currency?: string;
  metadata?: Record<string, string>;
}

interface StripeSubscription {
  id:                 string;
  status:             string;
  current_period_end: number;
  cancel_at_period_end: boolean;
  items: { data: Array<{ price: { id: string; nickname?: string; unit_amount?: number; currency: string; recurring?: { interval: string } } }> };
}

interface StripeCharge {
  id:       string;
  amount:   number;
  currency: string;
  created:  number;
  paid:     boolean;
  refunded: boolean;
  status:   string;
}

export interface StripeContext {
  customer:      StripeCustomer | null;
  subscriptions: StripeSubscription[];
  charges:       StripeCharge[];
}

async function stripeGet<T>(apiKey: string, path: string): Promise<T> {
  const res = await fetch(`${STRIPE_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Stripe ${path} returned ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Look up a Stripe customer by email + their subscriptions and recent
 * charges. Returns { customer: null, ... } when no Stripe customer
 * matches (which is the common case — most tickets are from people
 * who don't have a Stripe record).
 */
export async function fetchStripeContext(args: {
  apiKey: string;
  email:  string;
}): Promise<StripeContext> {
  const { apiKey, email } = args;

  const search = await stripeGet<{ data: StripeCustomer[] }>(
    apiKey,
    `/customers?email=${encodeURIComponent(email)}&limit=1`,
  );
  const customer = search.data[0] || null;
  if (!customer) return { customer: null, subscriptions: [], charges: [] };

  const [subs, chargesRes] = await Promise.all([
    stripeGet<{ data: StripeSubscription[] }>(
      apiKey,
      `/subscriptions?customer=${customer.id}&status=all&limit=10`,
    ),
    stripeGet<{ data: StripeCharge[] }>(
      apiKey,
      `/charges?customer=${customer.id}&limit=10`,
    ),
  ]);

  return {
    customer,
    subscriptions: subs.data,
    charges:       chargesRes.data,
  };
}
