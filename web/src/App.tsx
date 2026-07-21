import { useEffect, useRef, useState, useCallback } from "react";
import { io, type Socket } from "socket.io-client";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

type StockEvent = {
  productId: string;
  remaining: number;
  reason: "purchase" | "reserve" | "release" | "sweep_expired";
  ts: number;
};

type OrderStatus = "pending" | "paid" | "fulfilled" | "confirmed" | "failed";
type OrderRow = {
  _id: string;
  productId: string;
  quantity: number;
  totalPaise: number;
  status: OrderStatus;
  failureReason?: string;
  createdAt?: string;
};
type OrderEvent = { orderId: string; userId: string; status: OrderStatus; ts: number };

type Product = {
  _id: string;
  name: string;
  description: string;
  pricePaise: number;
  stock: number;
};

type Me = { id: string; email: string; name: string; role: "buyer" | "seller" | "admin" };
type Message = { kind: "ok" | "err"; text: string };

function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

export default function App() {
  // --- auth state -----------------------------------------------------------
  // Access token lives in memory (React state), NEVER localStorage — localStorage
  // is readable by any JS on the page, which XSS attacks exploit. Losing it on
  // page reload is the tradeoff; silent /auth/refresh on mount recovers it.
  const [me, setMe] = useState<Me | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const accessTokenRef = useRef<string | null>(null);
  accessTokenRef.current = accessToken;

  // Silent-refresh on mount: if the browser still has a valid refresh cookie
  // from a prior session, we can get a fresh access token without a login form.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_URL}/auth/refresh`, {
          method: "POST",
          credentials: "include",
        });
        if (res.ok) {
          const data = await res.json();
          setAccessToken(data.accessToken);
          setMe(data.user);
        }
      } finally {
        setAuthReady(true);
      }
    })();
  }, []);

  // Central fetch wrapper. Adds Authorization header if we have a token, and
  // on 401 tries /auth/refresh ONCE then retries the original request — that
  // way a token expiring mid-session is invisible to callers.
  const apiFetch = useCallback(
    async (path: string, init: RequestInit = {}, retried = false): Promise<Response> => {
      const headers = new Headers(init.headers ?? {});
      const token = accessTokenRef.current;
      if (token) headers.set("Authorization", `Bearer ${token}`);
      const res = await fetch(`${API_URL}${path}`, {
        ...init,
        headers,
        credentials: "include",
      });
      if (res.status === 401 && !retried) {
        const r = await fetch(`${API_URL}/auth/refresh`, {
          method: "POST",
          credentials: "include",
        });
        if (r.ok) {
          const data = await r.json();
          setAccessToken(data.accessToken);
          accessTokenRef.current = data.accessToken;
          setMe(data.user);
          return apiFetch(path, init, true);
        } else {
          setAccessToken(null);
          setMe(null);
        }
      }
      return res;
    },
    [],
  );

  const logout = async () => {
    await fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" });
    setAccessToken(null);
    setMe(null);
  };

  // --- products + realtime -------------------------------------------------
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [orders, setOrders] = useState<OrderRow[]>([]);

  const loadProducts = async () => {
    try {
      const res = await fetch(`${API_URL}/products`);
      const data = await res.json();
      setProducts(data.products ?? []);
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadProducts();
  }, []);

  const socketRef = useRef<Socket | null>(null);
  const subscribedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const s = io(API_URL, { transports: ["websocket", "polling"] });
    socketRef.current = s;
    s.on("stock", (ev: StockEvent) => {
      setProducts((prev) =>
        prev.map((p) => (p._id === ev.productId ? { ...p, stock: ev.remaining } : p)),
      );
    });
    s.on("order", (ev: OrderEvent) => {
      setOrders((prev) =>
        prev.map((o) =>
          o._id === ev.orderId ? { ...o, status: ev.status } : o,
        ),
      );
    });
    return () => {
      s.disconnect();
      socketRef.current = null;
      subscribedRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const s = socketRef.current;
    if (!s) return;
    for (const p of products) {
      if (!subscribedRef.current.has(p._id)) {
        s.emit("subscribe", p._id);
        subscribedRef.current.add(p._id);
      }
    }
  }, [products]);

  // Subscribe to per-user order events + hydrate the initial list.
  useEffect(() => {
    const s = socketRef.current;
    if (!s || !accessToken) return;
    s.emit("subscribeOrders", accessToken);
    void (async () => {
      const res = await apiFetch("/orders/mine");
      if (res.ok) {
        const data = await res.json();
        setOrders(data.orders ?? []);
      }
    })();
  }, [accessToken, apiFetch]);

  const buy = async (id: string) => {
    if (!me) return;
    setBusy((b) => ({ ...b, [id]: true }));
    setMessages((m) => ({ ...m, [id]: { kind: "ok", text: "buying…" } }));
    try {
      const res = await apiFetch(`/products/${id}/buy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ quantity: 1 }),
      });
      const data = await res.json();

      if (res.status === 201) {
        setMessages((m) => ({
          ...m,
          [id]: { kind: "ok", text: `✔ order placed — processing…` },
        }));
        setProducts((prev) =>
          prev.map((p) => (p._id === id ? { ...p, stock: data.remaining } : p)),
        );
        const product = products.find((p) => p._id === id);
        setOrders((prev) => [
          {
            _id: data.orderId,
            productId: id,
            quantity: data.quantity,
            totalPaise: (product?.pricePaise ?? 0) * data.quantity,
            status: "pending",
            createdAt: new Date().toISOString(),
          },
          ...prev,
        ]);
      } else if (res.status === 409) {
        setMessages((m) => ({ ...m, [id]: { kind: "err", text: "sold out" } }));
        setProducts((prev) => prev.map((p) => (p._id === id ? { ...p, stock: 0 } : p)));
      } else if (res.status === 429) {
        setMessages((m) => ({ ...m, [id]: { kind: "err", text: "slow down — rate limited" } }));
      } else {
        const msg = data?.error?.message ?? `HTTP ${res.status}`;
        setMessages((m) => ({ ...m, [id]: { kind: "err", text: msg } }));
      }
    } catch (e) {
      setMessages((m) => ({ ...m, [id]: { kind: "err", text: String(e) } }));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="max-w-6xl mx-auto p-6 md:p-10">
        <header className="mb-10 flex items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-3">
              <span className="text-3xl">⚡</span>
              <h1 className="text-4xl font-bold tracking-tight">Flashkart</h1>
            </div>
            <p className="text-slate-400 mt-2">
              Lightning deals · real inventory · zero overselling.
            </p>
          </div>
          {me ? (
            <div className="text-right text-sm">
              <div className="text-slate-300">
                {me.name} <span className="text-slate-500">· {me.role}</span>
              </div>
              <button
                onClick={() => void logout()}
                className="text-slate-500 hover:text-slate-300 mt-1"
              >
                log out
              </button>
            </div>
          ) : null}
        </header>

        {!authReady ? (
          <p className="text-slate-500">…</p>
        ) : !me ? (
          <AuthPanel
            onAuthed={(user, token) => {
              setMe(user);
              setAccessToken(token);
            }}
          />
        ) : (
          <>
            {loading && <p className="text-slate-500">loading products…</p>}
            {loadError && <p className="text-red-400">could not reach api: {loadError}</p>}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {products.map((p) => {
                const soldOut = p.stock <= 0;
                const low = !soldOut && p.stock < 10;
                const msg = messages[p._id];

                const stockClass = soldOut
                  ? "bg-red-900/40 text-red-300 ring-1 ring-red-800/50"
                  : low
                    ? "bg-amber-900/40 text-amber-300 ring-1 ring-amber-800/50"
                    : "bg-emerald-900/40 text-emerald-300 ring-1 ring-emerald-800/50";

                return (
                  <div
                    key={p._id}
                    className="bg-slate-900 rounded-xl p-5 flex flex-col ring-1 ring-slate-800"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="text-lg font-semibold leading-tight">{p.name}</h2>
                      <span
                        className={`text-xs px-2 py-1 rounded-full whitespace-nowrap ${stockClass}`}
                      >
                        {soldOut ? "sold out" : `${p.stock} left`}
                      </span>
                    </div>

                    <p className="text-slate-400 text-sm mt-2 flex-1">{p.description}</p>

                    <div className="mt-4 text-2xl font-bold">{formatRupees(p.pricePaise)}</div>

                    <button
                      onClick={() => void buy(p._id)}
                      disabled={soldOut || busy[p._id]}
                      className="mt-4 w-full py-2.5 rounded-lg font-medium bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed transition"
                    >
                      {soldOut ? "sold out" : busy[p._id] ? "buying…" : "buy 1"}
                    </button>

                    {msg && (
                      <p
                        className={`mt-2 text-sm ${
                          msg.kind === "ok" ? "text-emerald-400" : "text-red-400"
                        }`}
                      >
                        {msg.text}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            <OrdersPanel orders={orders} products={products} />
          </>
        )}

        <footer className="mt-12 text-xs text-slate-600">
          hot path: single Redis Lua script · durable prime from Mongo · no overselling under concurrency
        </footer>
      </div>
    </div>
  );
}

const ORDER_STAGES: OrderStatus[] = ["pending", "paid", "fulfilled", "confirmed"];

function OrdersPanel({ orders, products }: { orders: OrderRow[]; products: Product[] }) {
  if (orders.length === 0) return null;
  const nameOf = (id: string) => products.find((p) => p._id === id)?.name ?? "product";

  return (
    <section className="mt-10">
      <h3 className="text-lg font-semibold mb-3 text-slate-300">My orders</h3>
      <div className="space-y-2">
        {orders.map((o) => {
          const failed = o.status === "failed";
          const stageIdx = failed ? -1 : ORDER_STAGES.indexOf(o.status);
          return (
            <div
              key={o._id}
              className="bg-slate-900 rounded-lg p-4 ring-1 ring-slate-800 flex flex-wrap items-center gap-4"
            >
              <div className="flex-1 min-w-[160px]">
                <div className="font-medium">{nameOf(o.productId)}</div>
                <div className="text-xs text-slate-500">
                  qty {o.quantity} · ₹{(o.totalPaise / 100).toLocaleString("en-IN")}
                </div>
              </div>
              {failed ? (
                <div className="text-red-400 text-sm">
                  ✗ failed{o.failureReason ? ` — ${o.failureReason}` : ""}
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  {ORDER_STAGES.map((stage, i) => (
                    <div
                      key={stage}
                      className={`text-xs px-2 py-1 rounded-full ${
                        i <= stageIdx
                          ? "bg-emerald-900/50 text-emerald-300 ring-1 ring-emerald-800/50"
                          : "bg-slate-800/50 text-slate-500 ring-1 ring-slate-800"
                      }`}
                    >
                      {stage}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AuthPanel({ onAuthed }: { onAuthed: (u: Me, token: string) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "register") {
        const r = await fetch(`${API_URL}/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, name, password }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j?.error?.message ?? `register failed (${r.status})`);
        }
      }
      const r = await fetch(`${API_URL}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? `login failed (${r.status})`);
      }
      const data = await r.json();
      onAuthed(data.user, data.accessToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-md mx-auto bg-slate-900 rounded-xl p-6 ring-1 ring-slate-800">
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setMode("login")}
          className={`flex-1 py-2 rounded-md text-sm ${mode === "login" ? "bg-slate-700 text-white" : "text-slate-400"}`}
        >
          log in
        </button>
        <button
          onClick={() => setMode("register")}
          className={`flex-1 py-2 rounded-md text-sm ${mode === "register" ? "bg-slate-700 text-white" : "text-slate-400"}`}
        >
          register
        </button>
      </div>
      <form onSubmit={submit} className="space-y-3">
        {mode === "register" && (
          <input
            type="text"
            placeholder="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-slate-950 rounded-md px-3 py-2 ring-1 ring-slate-800 focus:ring-emerald-600 outline-none"
            required
          />
        )}
        <input
          type="email"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full bg-slate-950 rounded-md px-3 py-2 ring-1 ring-slate-800 focus:ring-emerald-600 outline-none"
          required
        />
        <input
          type="password"
          placeholder="password (min 8)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full bg-slate-950 rounded-md px-3 py-2 ring-1 ring-slate-800 focus:ring-emerald-600 outline-none"
          required
          minLength={8}
        />
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full py-2.5 rounded-lg font-medium bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:bg-slate-800 disabled:text-slate-500 transition"
        >
          {busy ? "…" : mode === "login" ? "log in" : "register + log in"}
        </button>
      </form>
    </div>
  );
}
