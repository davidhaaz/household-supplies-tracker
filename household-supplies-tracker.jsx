import { useState, useEffect, useCallback, useRef } from "react";
import { getApps, initializeApp } from "firebase/app";
import { getDatabase, get, ref, set } from "firebase/database";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";

/*
  Household Supplies Tracker
  ---------------------------------------------------------------
  Design direction: "the grocery aisle ticket book" — the app is styled
  like the tear-off restock cards and aisle signage you'd find in a
  well-run pantry. Circular "restock dials" (a nod to a kitchen timer
  knob) are the signature element, showing at a glance how far along
  each item is in its purchase cycle.

  Data layer: uses window.storage (shared = true) so every household
  member who opens this artifact reads and writes the same list. A
  lightweight poll simulates the "instant sync" the brief calls for,
  since a real Firestore backend isn't available inside an artifact.
*/

const STORAGE_KEY_DATA = "household-tracker-data-v1";
const STORAGE_KEY_ITEMS = "household-tracker-items-v1";
const STORAGE_KEY_USERS = "household-tracker-users-v1";
const POLL_MS = 4000;

const DEFAULT_USERS = [
  { id: "user_manager", name: "Manager", accessCode: "0000", isManager: true },
];

const DEFAULT_ITEMS = [
  {
    id: "item1",
    name: "Toilet Paper",
    category: "Bathroom",
    recurrenceDays: 14,
  },
  { id: "item2", name: "Dish Soap", category: "Kitchen", recurrenceDays: 30 },
  {
    id: "item3",
    name: "Laundry Detergent",
    category: "Laundry",
    recurrenceDays: 30,
  },
  {
    id: "item4",
    name: "Paper Towels",
    category: "Kitchen",
    recurrenceDays: 14,
  },
  { id: "item5", name: "Trash Bags", category: "Kitchen", recurrenceDays: 21 },
  { id: "item6", name: "Coffee", category: "Kitchen", recurrenceDays: 7 },
  {
    id: "item7",
    name: "Cleaning Supplies",
    category: "Cleaning",
    recurrenceDays: 30,
  },
];

const STORAGE_ENABLED =
  typeof window !== "undefined" &&
  window.storage &&
  typeof window.storage.get === "function" &&
  typeof window.storage.set === "function";

const FIREBASE_CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "",
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL || "",
};

let firebaseDb = null;
let firebaseAuth = null;
let firebaseInitAttempted = false;

function initFirebase() {
  if (firebaseInitAttempted) {
    return { db: firebaseDb, auth: firebaseAuth };
  }
  firebaseInitAttempted = true;

  if (!FIREBASE_CONFIG.projectId || !FIREBASE_CONFIG.databaseURL) {
    return { db: null, auth: null };
  }

  try {
    const existingApp = getApps().find(
      (app) => app.name === "household-tracker",
    );
    const app =
      existingApp || initializeApp(FIREBASE_CONFIG, "household-tracker");
    firebaseDb = getDatabase(app);
    firebaseAuth = getAuth(app);
    return { db: firebaseDb, auth: firebaseAuth };
  } catch (error) {
    console.warn("Firebase unavailable, falling back to local storage", error);
    return { db: null, auth: null };
  }
}

async function storageGet(key) {
  const { db, auth } = initFirebase();
  if (db && auth?.currentUser) {
    try {
      const snapshot = await get(ref(db, key));
      return snapshot.exists() ? snapshot.val() : null;
    } catch (error) {
      console.warn(`Unable to read ${key} from Firebase`, error);
    }
  }

  if (STORAGE_ENABLED) {
    const res = await window.storage.get(key, true);
    return res && res.value ? JSON.parse(res.value) : null;
  }

  const raw = window.localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

async function storageSet(key, value) {
  const { db, auth } = initFirebase();
  if (db && auth?.currentUser) {
    try {
      await set(ref(db, key), value);
      return;
    } catch (error) {
      console.warn(`Unable to save ${key} to Firebase`, error);
    }
  }

  if (STORAGE_ENABLED) {
    await window.storage.set(key, JSON.stringify(value), true);
    return;
  }

  window.localStorage.setItem(key, JSON.stringify(value));
}

function daysAgoISO(days, hours = 0) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(d.getHours() - hours);
  return d.toISOString();
}

function seedPurchases() {
  return [
    {
      id: "p1",
      itemId: "item1",
      userId: "user1",
      purchaseDate: daysAgoISO(20),
    },
    { id: "p2", itemId: "item2", userId: "user2", purchaseDate: daysAgoISO(6) },
    { id: "p3", itemId: "item3", userId: "user3", purchaseDate: daysAgoISO(4) },
    {
      id: "p4",
      itemId: "item4",
      userId: "user4",
      purchaseDate: daysAgoISO(12),
    },
    {
      id: "p5",
      itemId: "item5",
      userId: "user1",
      purchaseDate: daysAgoISO(18),
    },
    { id: "p6", itemId: "item6", userId: "user2", purchaseDate: daysAgoISO(5) },
    { id: "p7", itemId: "item7", userId: "user3", purchaseDate: daysAgoISO(9) },
    {
      id: "p1b",
      itemId: "item1",
      userId: "user2",
      purchaseDate: daysAgoISO(34),
    },
    {
      id: "p2b",
      itemId: "item2",
      userId: "user1",
      purchaseDate: daysAgoISO(36),
    },
    {
      id: "p6b",
      itemId: "item6",
      userId: "user4",
      purchaseDate: daysAgoISO(12),
    },
  ];
}

async function loadRemote() {
  try {
    const data = await storageGet(STORAGE_KEY_DATA);
    return data || null;
  } catch (e) {
    return null;
  }
}

async function saveRemote(data) {
  try {
    await storageSet(STORAGE_KEY_DATA, data);
  } catch (e) {
    console.error("Storage save failed", e);
  }
}

async function loadItems() {
  try {
    const data = await storageGet(STORAGE_KEY_ITEMS);
    return data || DEFAULT_ITEMS;
  } catch (e) {
    return DEFAULT_ITEMS;
  }
}

async function saveItems(items) {
  try {
    await storageSet(STORAGE_KEY_ITEMS, items);
  } catch (e) {
    console.error("Items save failed", e);
  }
}

async function loadUsers() {
  try {
    const data = await storageGet(STORAGE_KEY_USERS);
    return data || DEFAULT_USERS;
  } catch (e) {
    return DEFAULT_USERS;
  }
}

async function saveUsers(users) {
  try {
    await storageSet(STORAGE_KEY_USERS, users);
  } catch (e) {
    console.error("Users save failed", e);
  }
}

function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function latestPurchase(itemId, purchases) {
  const rel = purchases.filter((p) => p.itemId === itemId);
  if (rel.length === 0) return null;
  return rel.reduce((a, b) =>
    new Date(a.purchaseDate) > new Date(b.purchaseDate) ? a : b,
  );
}

function itemState(item, purchases) {
  const last = latestPurchase(item.id, purchases);
  if (!last) {
    return { status: "needed", daysSince: null, pct: 1, last: null };
  }
  const daysSince =
    (Date.now() - new Date(last.purchaseDate).getTime()) / 86400000;
  const pct = Math.min(1, daysSince / item.recurrenceDays);
  let status = "recent";
  if (pct >= 1) status = "needed";
  else if (pct >= 0.7) status = "dueSoon";
  return { status, daysSince, pct, last };
}

const STATUS_COLORS = {
  needed: {
    ring: "#C1440E",
    bg: "#FCEBE3",
    text: "#8A2F0A",
    label: "Needs purchase",
  },
  dueSoon: {
    ring: "#E8A93C",
    bg: "#FBF0DA",
    text: "#8A6011",
    label: "Due soon",
  },
  recent: {
    ring: "#1B7A4C",
    bg: "#E5F3EA",
    text: "#155C39",
    label: "Recently purchased",
  },
};

const PALETTE = {
  paper: "#FBF7EE",
  card: "#FFFFFF",
  ink: "#2B2B27",
  inkSoft: "#6B6A62",
  line: "#E4DFD1",
  forest: "#1B4332",
  mustard: "#E8A93C",
  rust: "#C1440E",
};

function RestockDial({ pct, status, size = 56 }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const color = STATUS_COLORS[status].ring;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ flexShrink: 0 }}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={PALETTE.line}
        strokeWidth="5"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 0.4s ease" }}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r - 9}
        fill={color}
        opacity="0.12"
      />
    </svg>
  );
}

function StatusBadge({ status }) {
  const s = STATUS_COLORS[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: "11px",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: s.text,
        background: s.bg,
        padding: "3px 8px",
        borderRadius: "999px",
        fontWeight: 600,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: s.ring,
          display: "inline-block",
        }}
      />
      {s.label}
    </span>
  );
}

function userName(users, id) {
  const u = users.find((u) => u.id === id);
  return u ? u.name : "Unknown";
}

export default function HouseholdTracker() {
  const [users, setUsers] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [items, setItems] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [view, setView] = useState("login"); // login | list | dashboard | detail | manage | adminUsers
  const [activeItemId, setActiveItemId] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [justBought, setJustBought] = useState(null);
  const [syncPulse, setSyncPulse] = useState(false);
  const pollRef = useRef(null);

  const initData = useCallback(async () => {
    let remote = await loadRemote();
    if (!remote || !remote.purchases) {
      remote = { purchases: seedPurchases() };
      await saveRemote(remote);
    }
    setPurchases(remote.purchases);

    const loadedItems = await loadItems();
    setItems(loadedItems);

    const loadedUsers = await loadUsers();
    setUsers(loadedUsers);

    setLoaded(true);
  }, []);

  useEffect(() => {
    initData();
  }, [initData]);

  useEffect(() => {
    const { auth } = initFirebase();
    if (!auth) return;

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setCurrentUser({
          id: user.uid,
          name: user.displayName || user.email?.split("@")[0] || "User",
          accessCode: "0000",
          isManager: false,
          email: user.email,
          firebaseUid: user.uid,
        });
        setView("list");
      } else {
        setCurrentUser(null);
        setView("login");
      }
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    pollRef.current = setInterval(async () => {
      const remote = await loadRemote();
      if (remote && remote.purchases) {
        setPurchases((prev) => {
          if (JSON.stringify(prev) !== JSON.stringify(remote.purchases)) {
            setSyncPulse(true);
            setTimeout(() => setSyncPulse(false), 900);
            return remote.purchases;
          }
          return prev;
        });
      }
    }, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, []);

  const handleLogout = async () => {
    const { auth } = initFirebase();
    if (auth) {
      try {
        await signOut(auth);
      } catch (error) {
        console.warn("Logout failed", error);
      }
    }
    setCurrentUser(null);
    setView("login");
  };

  const recordPurchase = async (itemId) => {
    if (!currentUser) return;
    const entry = {
      id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      itemId,
      userId: currentUser.id,
      purchaseDate: new Date().toISOString(),
    };
    const next = [...purchases, entry];
    setPurchases(next);
    setJustBought(itemId);
    setTimeout(() => setJustBought(null), 1600);
    await saveRemote({ purchases: next });
  };

  if (!loaded) {
    return (
      <div
        style={{
          minHeight: 400,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "'DM Sans', sans-serif",
          color: PALETTE.inkSoft,
        }}
      >
        Loading the pantry log…
      </div>
    );
  }

  if (!currentUser) {
    return (
      <FirebaseAuthLoginView
        onLoginSuccess={(user) => {
          setCurrentUser(user);
          setView("list");
        }}
      />
    );
  }

  const activeItem = items.find((i) => i.id === activeItemId);

  return (
    <div
      style={{
        background: PALETTE.paper,
        fontFamily: "'DM Sans', sans-serif",
        minHeight: 500,
        paddingBottom: "40px",
      }}
    >
      <GoogleFonts />

      {/* Header */}
      <div
        style={{
          borderBottom: `2px dashed ${PALETTE.line}`,
          padding: "18px 20px 16px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            flexWrap: "wrap",
            gap: "10px",
          }}
        >
          <div>
            <div
              style={{
                fontFamily: "'Archivo Black', sans-serif",
                fontSize: "11px",
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                color: PALETTE.forest,
              }}
            >
              Aisle 0 — Household
            </div>
            <h1
              style={{
                fontFamily: "'Archivo Black', sans-serif",
                fontSize: "24px",
                color: PALETTE.ink,
                margin: "2px 0 0",
              }}
            >
              Pantry Log
            </h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: syncPulse ? PALETTE.mustard : "#9BBE9F",
                transition: "background 0.3s ease",
              }}
              title="Sync status"
            />
            <span
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: "11px",
                color: PALETTE.inkSoft,
              }}
            >
              synced
            </span>
            <button
              onClick={handleLogout}
              style={{
                marginLeft: "6px",
                border: `1.5px solid ${PALETTE.line}`,
                background: PALETTE.card,
                borderRadius: "999px",
                padding: "6px 14px",
                fontSize: "13px",
                fontWeight: 700,
                color: PALETTE.ink,
                cursor: "pointer",
              }}
            >
              {currentUser.name} {currentUser.isManager ? "👤" : ""} ▾
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
          {[
            { key: "list", label: "List" },
            { key: "dashboard", label: "Stats" },
            { key: "manage", label: "Manage" },
            ...(currentUser.isManager
              ? [{ key: "adminUsers", label: "Users" }]
              : []),
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setView(t.key)}
              style={{
                border: "none",
                background: view === t.key ? PALETTE.forest : "transparent",
                color: view === t.key ? "#fff" : PALETTE.inkSoft,
                fontWeight: 700,
                fontSize: "13px",
                padding: "8px 16px",
                borderRadius: "8px",
                cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {view === "list" && (
        <ListView
          users={users}
          items={items}
          purchases={purchases}
          onBuy={recordPurchase}
          onOpen={(id) => {
            setActiveItemId(id);
            setView("detail");
          }}
          justBought={justBought}
        />
      )}

      {view === "detail" && activeItem && (
        <DetailView
          users={users}
          item={activeItem}
          purchases={purchases}
          onBack={() => setView("list")}
        />
      )}

      {view === "dashboard" && (
        <DashboardView users={users} items={items} purchases={purchases} />
      )}

      {view === "manage" && (
        <ManageView
          items={items}
          onAddItem={async (newItem) => {
            const updated = [...items, newItem];
            setItems(updated);
            await saveItems(updated);
          }}
          onRemoveItem={async (itemId) => {
            const updated = items.filter((i) => i.id !== itemId);
            setItems(updated);
            await saveItems(updated);
          }}
        />
      )}

      {view === "adminUsers" && currentUser.isManager && (
        <AdminUsersView
          users={users}
          onAddUser={async (newUser) => {
            const updated = [...users, newUser];
            setUsers(updated);
            await saveUsers(updated);
          }}
          onRemoveUser={async (userId) => {
            const updated = users.filter((u) => u.id !== userId);
            setUsers(updated);
            await saveUsers(updated);
          }}
          onUpdateUser={async (updatedUser) => {
            const updated = users.map((u) =>
              u.id === updatedUser.id ? updatedUser : u,
            );
            setUsers(updated);
            await saveUsers(updated);
          }}
        />
      )}
    </div>
  );
}

function ListView({ users, items, purchases, onBuy, onOpen, justBought }) {
  const sorted = [...items].sort((a, b) => {
    const sa = itemState(a, purchases);
    const sb = itemState(b, purchases);
    return sb.pct - sa.pct;
  });

  return (
    <div
      style={{
        padding: "18px 20px",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))",
        gap: "14px",
      }}
    >
      {sorted.map((item) => {
        const st = itemState(item, purchases);
        const colors = STATUS_COLORS[st.status];
        const bought = justBought === item.id;
        return (
          <div
            key={item.id}
            style={{
              background: PALETTE.card,
              border: `1.5px solid ${bought ? colors.ring : PALETTE.line}`,
              borderRadius: "14px",
              padding: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
              transition: "border-color 0.3s ease, box-shadow 0.3s ease",
              boxShadow: bought ? `0 0 0 3px ${colors.bg}` : "none",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: "10px",
              }}
            >
              <button
                onClick={() => onOpen(item.id)}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <div
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: "10px",
                    color: PALETTE.inkSoft,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  {item.category}
                </div>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: "17px",
                    color: PALETTE.ink,
                    marginTop: "2px",
                  }}
                >
                  {item.name}
                </div>
              </button>
              <RestockDial pct={st.pct} status={st.status} />
            </div>

            <StatusBadge status={st.status} />

            <div
              style={{
                fontSize: "13px",
                color: PALETTE.inkSoft,
                lineHeight: 1.5,
              }}
            >
              {st.last ? (
                <>
                  Last bought by{" "}
                  <strong style={{ color: PALETTE.ink }}>
                    {userName(users, st.last.userId)}
                  </strong>
                  <br />
                  {relTime(st.last.purchaseDate)} · restocks every{" "}
                  {item.recurrenceDays}d
                </>
              ) : (
                <>Never logged yet · restocks every {item.recurrenceDays}d</>
              )}
            </div>

            <button
              onClick={() => onBuy(item.id)}
              style={{
                marginTop: "4px",
                border: "none",
                background: bought ? colors.ring : PALETTE.forest,
                color: "#fff",
                fontWeight: 700,
                fontSize: "13px",
                padding: "10px",
                borderRadius: "9px",
                cursor: "pointer",
                transition: "background 0.2s ease, transform 0.15s ease",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.transform = "translateY(-1px)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.transform = "translateY(0)")
              }
            >
              {bought ? "✓ Logged just now" : "I bought this"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function DetailView({ users, item, purchases, onBack }) {
  const history = purchases
    .filter((p) => p.itemId === item.id)
    .sort((a, b) => new Date(b.purchaseDate) - new Date(a.purchaseDate));

  return (
    <div style={{ padding: "18px 20px" }}>
      <button
        onClick={onBack}
        style={{
          border: "none",
          background: "none",
          color: PALETTE.forest,
          fontWeight: 700,
          fontSize: "13px",
          cursor: "pointer",
          padding: 0,
          marginBottom: "16px",
        }}
      >
        ← Back to list
      </button>

      <div
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: "10px",
          color: PALETTE.inkSoft,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {item.category} · restocks every {item.recurrenceDays} days
      </div>
      <h2
        style={{
          fontFamily: "'Archivo Black', sans-serif",
          fontSize: "22px",
          color: PALETTE.ink,
          margin: "4px 0 18px",
        }}
      >
        {item.name}
      </h2>

      <div
        style={{
          background: PALETTE.card,
          border: `1.5px dashed ${PALETTE.line}`,
          borderRadius: "12px",
          padding: "6px 18px",
        }}
      >
        <div
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: "11px",
            color: PALETTE.inkSoft,
            padding: "10px 0",
            borderBottom: `1px solid ${PALETTE.line}`,
          }}
        >
          PURCHASE HISTORY
        </div>
        {history.length === 0 && (
          <div
            style={{
              padding: "16px 0",
              color: PALETTE.inkSoft,
              fontSize: "13px",
            }}
          >
            No purchases logged yet.
          </div>
        )}
        {history.map((p, idx) => (
          <div
            key={p.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "12px 0",
              borderBottom:
                idx === history.length - 1
                  ? "none"
                  : `1px solid ${PALETTE.line}`,
            }}
          >
            <div>
              <div
                style={{
                  fontWeight: 700,
                  fontSize: "14px",
                  color: PALETTE.ink,
                }}
              >
                {userName(users, p.userId)}
              </div>
              <div
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: "11px",
                  color: PALETTE.inkSoft,
                }}
              >
                {formatDate(p.purchaseDate)}
              </div>
            </div>
            <div style={{ fontSize: "12px", color: PALETTE.inkSoft }}>
              {relTime(p.purchaseDate)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DashboardView({ users, items, purchases }) {
  const totalsByUser = users
    .map((u) => ({
      ...u,
      count: purchases.filter((p) => p.userId === u.id).length,
    }))
    .sort((a, b) => b.count - a.count);
  const maxCount = Math.max(1, ...totalsByUser.map((u) => u.count));

  const itemCounts = items
    .map((it) => ({
      ...it,
      count: purchases.filter((p) => p.itemId === it.id).length,
    }))
    .sort((a, b) => b.count - a.count);

  const avgDaysByItem = items.map((it) => {
    const hist = purchases
      .filter((p) => p.itemId === it.id)
      .sort((a, b) => new Date(a.purchaseDate) - new Date(b.purchaseDate));
    if (hist.length < 2) return { name: it.name, avg: null };
    let total = 0;
    for (let i = 1; i < hist.length; i++) {
      total +=
        (new Date(hist[i].purchaseDate) - new Date(hist[i - 1].purchaseDate)) /
        86400000;
    }
    return { name: it.name, avg: Math.round(total / (hist.length - 1)) };
  });

  const lastActivity = [...purchases]
    .sort((a, b) => new Date(b.purchaseDate) - new Date(a.purchaseDate))
    .slice(0, 5);

  const upcoming = items
    .map((it) => {
      const last = latestPurchase(it.id, purchases);
      const dueIn = last
        ? Math.ceil(
            it.recurrenceDays -
              (Date.now() - new Date(last.purchaseDate).getTime()) / 86400000,
          )
        : 0;
      return { name: it.name, dueIn };
    })
    .sort((a, b) => a.dueIn - b.dueIn);

  return (
    <div
      style={{
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: "22px",
      }}
    >
      <section>
        <SectionLabel>Household statistics</SectionLabel>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            marginTop: "10px",
          }}
        >
          {totalsByUser.map((u) => (
            <div
              key={u.id}
              style={{ display: "flex", alignItems: "center", gap: "10px" }}
            >
              <div
                style={{
                  width: "60px",
                  fontSize: "13px",
                  fontWeight: 700,
                  color: PALETTE.ink,
                }}
              >
                {u.name}
              </div>
              <div
                style={{
                  flex: 1,
                  background: PALETTE.line,
                  borderRadius: "6px",
                  height: "14px",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${(u.count / maxCount) * 100}%`,
                    background: PALETTE.forest,
                    height: "100%",
                    borderRadius: "6px",
                    transition: "width 0.4s ease",
                  }}
                />
              </div>
              <div
                style={{
                  width: "70px",
                  textAlign: "right",
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: "12px",
                  color: PALETTE.inkSoft,
                }}
              >
                {u.count} purchase{u.count === 1 ? "" : "s"}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <SectionLabel>Most frequently purchased</SectionLabel>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "8px",
            marginTop: "10px",
          }}
        >
          {itemCounts.slice(0, 5).map((it) => (
            <div
              key={it.id}
              style={{
                background: PALETTE.card,
                border: `1px solid ${PALETTE.line}`,
                borderRadius: "10px",
                padding: "8px 12px",
                fontSize: "12px",
                color: PALETTE.ink,
              }}
            >
              <strong>{it.name}</strong> · {it.count}×
            </div>
          ))}
        </div>
      </section>

      <section>
        <SectionLabel>Average days between purchases</SectionLabel>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            marginTop: "10px",
          }}
        >
          {avgDaysByItem.map((it) => (
            <div
              key={it.name}
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "13px",
                padding: "6px 0",
                borderBottom: `1px solid ${PALETTE.line}`,
              }}
            >
              <span style={{ color: PALETTE.ink }}>{it.name}</span>
              <span
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  color: PALETTE.inkSoft,
                }}
              >
                {it.avg === null ? "not enough data" : `${it.avg} days`}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <SectionLabel>Last activity</SectionLabel>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            marginTop: "10px",
          }}
        >
          {lastActivity.map((p) => {
            const it = items.find((i) => i.id === p.itemId);
            return (
              <div
                key={p.id}
                style={{
                  fontSize: "13px",
                  color: PALETTE.inkSoft,
                  padding: "4px 0",
                }}
              >
                <strong style={{ color: PALETTE.ink }}>
                  {userName(users, p.userId)}
                </strong>{" "}
                bought{" "}
                <strong style={{ color: PALETTE.ink }}>
                  {it ? it.name : "an item"}
                </strong>{" "}
                · {relTime(p.purchaseDate)}
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <SectionLabel>Upcoming</SectionLabel>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            marginTop: "10px",
          }}
        >
          {upcoming.map((u) => (
            <div
              key={u.name}
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "13px",
                padding: "6px 0",
                borderBottom: `1px solid ${PALETTE.line}`,
              }}
            >
              <span style={{ color: PALETTE.ink }}>{u.name}</span>
              <span
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  color: u.dueIn <= 0 ? PALETTE.rust : PALETTE.inkSoft,
                }}
              >
                {u.dueIn <= 0 ? "due now" : `due in ${u.dueIn}d`}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div
      style={{
        fontFamily: "'Archivo Black', sans-serif",
        fontSize: "13px",
        color: PALETTE.forest,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
      }}
    >
      {children}
    </div>
  );
}

function LoginView({ users, onLoginSuccess, onAddUser }) {
  const [step, setStep] = useState("home"); // home | nameInput | pinEntry | createAccount
  const [userMode, setUserMode] = useState(null); // existing | newUser
  const [nameInput, setNameInput] = useState("");
  const [pin, setPin] = useState("");
  const [newAccessCode, setNewAccessCode] = useState("");
  const [error, setError] = useState("");
  const [selectedUser, setSelectedUser] = useState(null);

  const handleNameSubmit = () => {
    const trimmedName = nameInput.trim();
    if (!trimmedName) {
      setError("Please enter your name");
      return;
    }

    const existingUser = users.find(
      (u) => u.name.toLowerCase() === trimmedName.toLowerCase(),
    );
    if (existingUser) {
      setSelectedUser(existingUser);
      setStep("pinEntry");
      setError("");
    } else {
      setStep("createAccount");
      setError("");
    }
  };

  // Handle PIN completion with useEffect to avoid state batching issues
  useEffect(() => {
    if (pin.length === 4 && step === "pinEntry" && selectedUser) {
      if (selectedUser.accessCode === pin) {
        onLoginSuccess(selectedUser);
      } else {
        setError("Incorrect access code");
        setPin("");
      }
    }
  }, [pin, step, selectedUser, onLoginSuccess]);

  const handleDigitClick = (digit) => {
    if (pin.length < 4) {
      setPin(pin + digit);
      setError("");
    }
  };

  const handleBackspace = () => {
    setPin(pin.slice(0, -1));
    setError("");
  };

  const handleCreateAccount = async () => {
    const trimmedName = nameInput.trim();
    if (!trimmedName || newAccessCode.length !== 4) {
      setError("Please enter name and 4-digit access code");
      return;
    }

    // Check if name already exists (case-insensitive)
    if (users.some((u) => u.name.toLowerCase() === trimmedName.toLowerCase())) {
      setError("This name already exists");
      return;
    }

    const newUser = {
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: trimmedName,
      accessCode: newAccessCode,
      isManager: false,
    };

    await onAddUser(newUser);
    onLoginSuccess(newUser);
  };

  const handleBackToHome = () => {
    setStep("home");
    setUserMode(null);
    setNameInput("");
    setPin("");
    setNewAccessCode("");
    setError("");
    setSelectedUser(null);
  };

  const handleBackToName = () => {
    setStep("nameInput");
    setPin("");
    setNewAccessCode("");
    setError("");
    setSelectedUser(null);
  };

  const goToNameInput = (mode) => {
    setUserMode(mode);
    setStep("nameInput");
    setError("");
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: PALETTE.paper,
        fontFamily: "'DM Sans', sans-serif",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
      }}
    >
      <GoogleFonts />
      <div style={{ maxWidth: 340, width: "100%", textAlign: "center" }}>
        <div
          style={{
            fontFamily: "'Archivo Black', sans-serif",
            fontSize: "12px",
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            color: PALETTE.forest,
            marginBottom: "6px",
          }}
        >
          Aisle 0 — Household
        </div>
        <h1
          style={{
            fontFamily: "'Archivo Black', sans-serif",
            fontSize: "28px",
            color: PALETTE.ink,
            margin: "0 0 20px",
            lineHeight: 1.1,
          }}
        >
          Pantry Log
        </h1>

        {step === "home" && (
          <>
            <p
              style={{
                color: PALETTE.inkSoft,
                fontSize: "14px",
                margin: "0 0 24px",
              }}
            >
              How would you like to access your account?
            </p>
            <div
              style={{ display: "flex", flexDirection: "column", gap: "10px" }}
            >
              <button
                onClick={() => goToNameInput("existing")}
                style={{
                  border: `2px solid ${PALETTE.forest}`,
                  background: PALETTE.forest,
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: "15px",
                  padding: "16px",
                  borderRadius: "12px",
                  cursor: "pointer",
                  transition: "transform 0.15s ease, background 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "translateY(-2px)";
                  e.currentTarget.style.background = "#0d3821";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "translateY(0)";
                  e.currentTarget.style.background = PALETTE.forest;
                }}
              >
                Existing user
              </button>
              <button
                onClick={() => goToNameInput("newUser")}
                style={{
                  border: `2px solid ${PALETTE.forest}`,
                  background: "transparent",
                  color: PALETTE.forest,
                  fontWeight: 700,
                  fontSize: "15px",
                  padding: "16px",
                  borderRadius: "12px",
                  cursor: "pointer",
                  transition: "transform 0.15s ease, background 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "translateY(-2px)";
                  e.currentTarget.style.background = "rgba(27, 67, 50, 0.08)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "translateY(0)";
                  e.currentTarget.style.background = "transparent";
                }}
              >
                New user
              </button>
            </div>
          </>
        )}

        {step === "nameInput" && (
          <>
            <button
              onClick={handleBackToHome}
              style={{
                border: "none",
                background: "none",
                color: PALETTE.forest,
                fontWeight: 700,
                fontSize: "12px",
                cursor: "pointer",
                padding: 0,
                marginBottom: "16px",
              }}
            >
              ← Back
            </button>

            <p
              style={{
                color: PALETTE.inkSoft,
                fontSize: "14px",
                margin: "0 0 18px",
              }}
            >
              {userMode === "existing" ? "Welcome back" : "Create your account"}
            </p>
            <input
              type="text"
              value={nameInput}
              onChange={(e) => {
                setNameInput(e.target.value);
                setError("");
              }}
              onKeyPress={(e) => {
                if (e.key === "Enter") handleNameSubmit();
              }}
              placeholder="Enter your name"
              autoFocus
              style={{
                width: "100%",
                padding: "12px 14px",
                border: `1.5px solid ${error ? PALETTE.rust : PALETTE.line}`,
                borderRadius: "10px",
                fontSize: "15px",
                fontFamily: "'DM Sans', sans-serif",
                boxSizing: "border-box",
                marginBottom: "12px",
                transition: "border-color 0.2s ease",
              }}
            />
            {error && (
              <div
                style={{
                  background: "#FCEBE3",
                  color: PALETTE.rust,
                  padding: "10px",
                  borderRadius: "8px",
                  fontSize: "12px",
                  fontWeight: 600,
                  marginBottom: "12px",
                }}
              >
                {error}
              </div>
            )}
            <button
              onClick={handleNameSubmit}
              style={{
                width: "100%",
                border: "none",
                background: PALETTE.forest,
                color: "#fff",
                fontWeight: 700,
                fontSize: "14px",
                padding: "12px",
                borderRadius: "9px",
                cursor: "pointer",
                transition: "background 0.2s ease",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "#0d3821")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = PALETTE.forest)
              }
            >
              Continue
            </button>
          </>
        )}

        {step === "pinEntry" && selectedUser && (
          <>
            <button
              onClick={handleBackToName}
              style={{
                border: "none",
                background: "none",
                color: PALETTE.forest,
                fontWeight: 700,
                fontSize: "12px",
                cursor: "pointer",
                padding: 0,
                marginBottom: "16px",
              }}
            >
              ← Back
            </button>

            <p
              style={{
                color: PALETTE.inkSoft,
                fontSize: "14px",
                margin: "0 0 8px",
              }}
            >
              Enter access code for
            </p>
            <p
              style={{
                fontWeight: 700,
                fontSize: "16px",
                color: PALETTE.ink,
                margin: "0 0 24px",
              }}
            >
              {selectedUser.name}
            </p>

            {/* PIN Display */}
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                gap: "10px",
                marginBottom: "28px",
              }}
            >
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: "50%",
                    border: `2px solid ${error ? PALETTE.rust : pin.length > i ? PALETTE.forest : PALETTE.line}`,
                    background: pin.length > i ? PALETTE.forest : "transparent",
                    transition: "all 0.2s ease",
                  }}
                />
              ))}
            </div>

            {error && (
              <div
                style={{
                  background: "#FCEBE3",
                  color: PALETTE.rust,
                  padding: "10px",
                  borderRadius: "8px",
                  fontSize: "12px",
                  fontWeight: 600,
                  marginBottom: "16px",
                }}
              >
                {error}
              </div>
            )}

            {/* Numeric Keypad */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: "8px",
                marginBottom: "12px",
              }}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => (
                <button
                  key={digit}
                  onClick={() => handleDigitClick(digit.toString())}
                  style={{
                    border: `1.5px solid ${PALETTE.line}`,
                    background: PALETTE.card,
                    borderRadius: "10px",
                    padding: "14px",
                    fontSize: "18px",
                    fontWeight: 700,
                    color: PALETTE.ink,
                    cursor: "pointer",
                    transition: "transform 0.1s ease, background 0.1s ease",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = PALETTE.line;
                    e.currentTarget.style.transform = "scale(0.96)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = PALETTE.card;
                    e.currentTarget.style.transform = "scale(1)";
                  }}
                >
                  {digit}
                </button>
              ))}
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: "8px",
              }}
            >
              <button
                onClick={() => handleDigitClick("0")}
                style={{
                  gridColumn: "2",
                  border: `1.5px solid ${PALETTE.line}`,
                  background: PALETTE.card,
                  borderRadius: "10px",
                  padding: "14px",
                  fontSize: "18px",
                  fontWeight: 700,
                  color: PALETTE.ink,
                  cursor: "pointer",
                  transition: "transform 0.1s ease, background 0.1s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = PALETTE.line;
                  e.currentTarget.style.transform = "scale(0.96)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = PALETTE.card;
                  e.currentTarget.style.transform = "scale(1)";
                }}
              >
                0
              </button>
              <button
                onClick={handleBackspace}
                style={{
                  border: `1.5px solid ${PALETTE.line}`,
                  background: PALETTE.card,
                  borderRadius: "10px",
                  padding: "14px",
                  fontSize: "16px",
                  fontWeight: 700,
                  color: PALETTE.inkSoft,
                  cursor: "pointer",
                  transition: "transform 0.1s ease, background 0.1s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = PALETTE.line;
                  e.currentTarget.style.transform = "scale(0.96)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = PALETTE.card;
                  e.currentTarget.style.transform = "scale(1)";
                }}
              >
                ⌫
              </button>
            </div>
          </>
        )}

        {step === "createAccount" && (
          <>
            <button
              onClick={handleBackToName}
              style={{
                border: "none",
                background: "none",
                color: PALETTE.forest,
                fontWeight: 700,
                fontSize: "12px",
                cursor: "pointer",
                padding: 0,
                marginBottom: "16px",
              }}
            >
              ← Back
            </button>

            <p
              style={{
                color: PALETTE.inkSoft,
                fontSize: "14px",
                margin: "0 0 8px",
              }}
            >
              New user detected
            </p>
            <p
              style={{
                fontWeight: 700,
                fontSize: "16px",
                color: PALETTE.ink,
                margin: "0 0 20px",
              }}
            >
              {nameInput}
            </p>

            <div style={{ marginBottom: "16px" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "12px",
                  fontWeight: 700,
                  color: PALETTE.inkSoft,
                  marginBottom: "8px",
                  textTransform: "uppercase",
                }}
              >
                Create your access code
              </label>
              <p
                style={{
                  fontSize: "12px",
                  color: PALETTE.inkSoft,
                  margin: "0 0 12px",
                }}
              >
                Enter a 4-digit code (like your phone PIN)
              </p>

              {/* Code Display */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  gap: "10px",
                  marginBottom: "20px",
                }}
              >
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: "50%",
                      border: `2px solid ${error ? PALETTE.rust : newAccessCode.length > i ? PALETTE.forest : PALETTE.line}`,
                      background:
                        newAccessCode.length > i
                          ? PALETTE.forest
                          : "transparent",
                      transition: "all 0.2s ease",
                    }}
                  />
                ))}
              </div>

              {error && (
                <div
                  style={{
                    background: "#FCEBE3",
                    color: PALETTE.rust,
                    padding: "10px",
                    borderRadius: "8px",
                    fontSize: "12px",
                    fontWeight: 600,
                    marginBottom: "12px",
                  }}
                >
                  {error}
                </div>
              )}

              {/* Numeric Keypad */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: "8px",
                  marginBottom: "12px",
                }}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => (
                  <button
                    key={digit}
                    onClick={() => {
                      if (newAccessCode.length < 4) {
                        setNewAccessCode(newAccessCode + digit.toString());
                        setError("");
                      }
                    }}
                    style={{
                      border: `1.5px solid ${PALETTE.line}`,
                      background: PALETTE.card,
                      borderRadius: "10px",
                      padding: "14px",
                      fontSize: "18px",
                      fontWeight: 700,
                      color: PALETTE.ink,
                      cursor: newAccessCode.length < 4 ? "pointer" : "default",
                      transition: "transform 0.1s ease, background 0.1s ease",
                      opacity: newAccessCode.length < 4 ? 1 : 0.6,
                    }}
                    onMouseEnter={(e) => {
                      if (newAccessCode.length < 4) {
                        e.currentTarget.style.background = PALETTE.line;
                        e.currentTarget.style.transform = "scale(0.96)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = PALETTE.card;
                      e.currentTarget.style.transform = "scale(1)";
                    }}
                  >
                    {digit}
                  </button>
                ))}
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: "8px",
                  marginBottom: "16px",
                }}
              >
                <button
                  onClick={() => {
                    if (newAccessCode.length < 4) {
                      setNewAccessCode(newAccessCode + "0");
                      setError("");
                    }
                  }}
                  style={{
                    gridColumn: "2",
                    border: `1.5px solid ${PALETTE.line}`,
                    background: PALETTE.card,
                    borderRadius: "10px",
                    padding: "14px",
                    fontSize: "18px",
                    fontWeight: 700,
                    color: PALETTE.ink,
                    cursor: newAccessCode.length < 4 ? "pointer" : "default",
                    transition: "transform 0.1s ease, background 0.1s ease",
                    opacity: newAccessCode.length < 4 ? 1 : 0.6,
                  }}
                  onMouseEnter={(e) => {
                    if (newAccessCode.length < 4) {
                      e.currentTarget.style.background = PALETTE.line;
                      e.currentTarget.style.transform = "scale(0.96)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = PALETTE.card;
                    e.currentTarget.style.transform = "scale(1)";
                  }}
                >
                  0
                </button>
                <button
                  onClick={() => setNewAccessCode(newAccessCode.slice(0, -1))}
                  style={{
                    border: `1.5px solid ${PALETTE.line}`,
                    background: PALETTE.card,
                    borderRadius: "10px",
                    padding: "14px",
                    fontSize: "16px",
                    fontWeight: 700,
                    color: PALETTE.inkSoft,
                    cursor: "pointer",
                    transition: "transform 0.1s ease, background 0.1s ease",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = PALETTE.line;
                    e.currentTarget.style.transform = "scale(0.96)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = PALETTE.card;
                    e.currentTarget.style.transform = "scale(1)";
                  }}
                >
                  ⌫
                </button>
              </div>

              <button
                onClick={handleCreateAccount}
                disabled={newAccessCode.length !== 4}
                style={{
                  width: "100%",
                  border: "none",
                  background:
                    newAccessCode.length === 4 ? PALETTE.forest : PALETTE.line,
                  color: newAccessCode.length === 4 ? "#fff" : PALETTE.inkSoft,
                  fontWeight: 700,
                  fontSize: "14px",
                  padding: "12px",
                  borderRadius: "9px",
                  cursor: newAccessCode.length === 4 ? "pointer" : "default",
                  transition: "background 0.2s ease",
                }}
              >
                Create account
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FirebaseAuthLoginView({ onLoginSuccess }) {
  const [mode, setMode] = useState("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");

    if (!email.trim() || !password) {
      setError("Please enter an email and password.");
      return;
    }

    const { auth } = initFirebase();
    if (!auth) {
      setError("Firebase is not configured yet. Add your .env values first.");
      return;
    }

    setLoading(true);
    try {
      let userCredential;
      if (mode === "signup") {
        if (!name.trim()) {
          setError("Please enter your name.");
          setLoading(false);
          return;
        }
        userCredential = await createUserWithEmailAndPassword(
          auth,
          email.trim(),
          password,
        );
        await updateProfile(userCredential.user, { displayName: name.trim() });
      } else {
        userCredential = await signInWithEmailAndPassword(
          auth,
          email.trim(),
          password,
        );
      }

      const user = userCredential.user;
      onLoginSuccess({
        id: user.uid,
        name:
          user.displayName ||
          name.trim() ||
          user.email?.split("@")[0] ||
          "User",
        accessCode: "0000",
        isManager: false,
        email: user.email,
        firebaseUid: user.uid,
      });
    } catch (authError) {
      setError(authError.message || "Authentication failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: PALETTE.paper,
        fontFamily: "'DM Sans', sans-serif",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
      }}
    >
      <GoogleFonts />
      <div style={{ maxWidth: 360, width: "100%", textAlign: "center" }}>
        <div
          style={{
            fontFamily: "'Archivo Black', sans-serif",
            fontSize: "12px",
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            color: PALETTE.forest,
            marginBottom: "6px",
          }}
        >
          Aisle 0 — Household
        </div>
        <h1
          style={{
            fontFamily: "'Archivo Black', sans-serif",
            fontSize: "28px",
            color: PALETTE.ink,
            margin: "0 0 20px",
            lineHeight: 1.1,
          }}
        >
          Pantry Log
        </h1>
        <p
          style={{
            color: PALETTE.inkSoft,
            fontSize: "14px",
            margin: "0 0 20px",
          }}
        >
          {mode === "login"
            ? "Sign in with your Firebase account"
            : "Create a new Firebase account"}
        </p>

        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", flexDirection: "column", gap: "10px" }}
        >
          {mode === "signup" && (
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Your name"
              style={{
                width: "100%",
                padding: "12px 14px",
                border: `1.5px solid ${PALETTE.line}`,
                borderRadius: "10px",
                fontSize: "15px",
                boxSizing: "border-box",
              }}
            />
          )}
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Email"
            style={{
              width: "100%",
              padding: "12px 14px",
              border: `1.5px solid ${PALETTE.line}`,
              borderRadius: "10px",
              fontSize: "15px",
              boxSizing: "border-box",
            }}
          />
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password"
            style={{
              width: "100%",
              padding: "12px 14px",
              border: `1.5px solid ${PALETTE.line}`,
              borderRadius: "10px",
              fontSize: "15px",
              boxSizing: "border-box",
            }}
          />
          {error && (
            <div
              style={{
                background: "#FCEBE3",
                color: PALETTE.rust,
                padding: "10px",
                borderRadius: "8px",
                fontSize: "12px",
                fontWeight: 600,
              }}
            >
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            style={{
              border: "none",
              background: PALETTE.forest,
              color: "#fff",
              fontWeight: 700,
              fontSize: "14px",
              padding: "12px",
              borderRadius: "9px",
              cursor: loading ? "default" : "pointer",
              opacity: loading ? 0.8 : 1,
            }}
          >
            {loading
              ? "Please wait..."
              : mode === "login"
                ? "Sign in"
                : "Create account"}
          </button>
        </form>

        <button
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError("");
          }}
          style={{
            marginTop: "12px",
            border: "none",
            background: "transparent",
            color: PALETTE.forest,
            fontWeight: 700,
            fontSize: "13px",
            cursor: "pointer",
          }}
        >
          {mode === "login"
            ? "Need an account? Create one"
            : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}

function AdminUsersView({ users, onAddUser, onRemoveUser, onUpdateUser }) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [toDelete, setToDelete] = useState(null);
  const [editingUser, setEditingUser] = useState(null);

  const handleAdd = async () => {
    if (!name.trim() || accessCode.length !== 4) return;
    const newUser = {
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: name.trim(),
      accessCode,
      isManager: false,
    };
    await onAddUser(newUser);
    setName("");
    setAccessCode("");
    setShowForm(false);
  };

  const handleDelete = async (userId) => {
    await onRemoveUser(userId);
    setToDelete(null);
  };

  const handleUpdateCode = async (user, newCode) => {
    if (newCode.length === 4) {
      await onUpdateUser({ ...user, accessCode: newCode });
      setEditingUser(null);
    }
  };

  return (
    <div style={{ padding: "18px 20px", maxWidth: 600 }}>
      <div style={{ marginBottom: "20px" }}>
        <button
          onClick={() => setShowForm(!showForm)}
          style={{
            border: "none",
            background: PALETTE.forest,
            color: "#fff",
            fontWeight: 700,
            fontSize: "13px",
            padding: "12px 16px",
            borderRadius: "9px",
            cursor: "pointer",
            width: "100%",
            transition: "background 0.2s ease",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#0d3821")}
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = PALETTE.forest)
          }
        >
          {showForm ? "Cancel" : "+ Add new user"}
        </button>
      </div>

      {showForm && (
        <div
          style={{
            background: PALETTE.card,
            border: `1.5px dashed ${PALETTE.line}`,
            borderRadius: "12px",
            padding: "16px",
            marginBottom: "20px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <div>
            <label
              style={{
                display: "block",
                fontSize: "12px",
                fontWeight: 700,
                color: PALETTE.inkSoft,
                marginBottom: "4px",
                textTransform: "uppercase",
              }}
            >
              User name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., John"
              style={{
                width: "100%",
                padding: "10px 12px",
                border: `1px solid ${PALETTE.line}`,
                borderRadius: "8px",
                fontSize: "14px",
                fontFamily: "'DM Sans', sans-serif",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: "block",
                fontSize: "12px",
                fontWeight: 700,
                color: PALETTE.inkSoft,
                marginBottom: "4px",
                textTransform: "uppercase",
              }}
            >
              Access code (4 digits)
            </label>
            <input
              type="text"
              value={accessCode}
              onChange={(e) => {
                const val = e.target.value.slice(0, 4);
                if (/^\d*$/.test(val)) setAccessCode(val);
              }}
              placeholder="0000"
              maxLength="4"
              style={{
                width: "100%",
                padding: "10px 12px",
                border: `1px solid ${PALETTE.line}`,
                borderRadius: "8px",
                fontSize: "14px",
                fontFamily: "'IBM Plex Mono', monospace",
                boxSizing: "border-box",
                letterSpacing: "4px",
              }}
            />
            <div
              style={{
                fontSize: "11px",
                color: PALETTE.inkSoft,
                marginTop: "4px",
              }}
            >
              {accessCode.length}/4 digits
            </div>
          </div>

          <button
            onClick={handleAdd}
            disabled={!name.trim() || accessCode.length !== 4}
            style={{
              border: "none",
              background:
                name.trim() && accessCode.length === 4
                  ? PALETTE.forest
                  : PALETTE.line,
              color:
                name.trim() && accessCode.length === 4
                  ? "#fff"
                  : PALETTE.inkSoft,
              fontWeight: 700,
              fontSize: "13px",
              padding: "10px",
              borderRadius: "8px",
              cursor:
                name.trim() && accessCode.length === 4 ? "pointer" : "default",
              marginTop: "4px",
            }}
          >
            Add user
          </button>
        </div>
      )}

      <section>
        <SectionLabel>Users ({users.length})</SectionLabel>
        <div
          style={{
            marginTop: "12px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          {users.map((u) => (
            <div
              key={u.id}
              style={{
                background: PALETTE.card,
                border: `1px solid ${PALETTE.line}`,
                borderRadius: "10px",
                padding: "12px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "10px",
                }}
              >
                <div>
                  <div
                    style={{
                      fontWeight: 700,
                      fontSize: "14px",
                      color: PALETTE.ink,
                    }}
                  >
                    {u.name} {u.isManager ? "👤 Manager" : ""}
                  </div>
                  <div style={{ fontSize: "11px", color: PALETTE.inkSoft }}>
                    Access code:{" "}
                    <span
                      style={{
                        fontFamily: "'IBM Plex Mono', monospace",
                        fontWeight: 600,
                      }}
                    >
                      {u.accessCode}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => setToDelete(u.id)}
                  style={{
                    border: "1px solid #FCEBE3",
                    background: "#FCEBE3",
                    color: PALETTE.rust,
                    fontWeight: 600,
                    fontSize: "12px",
                    padding: "6px 10px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {toDelete && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
            zIndex: 1000,
          }}
          onClick={() => setToDelete(null)}
        >
          <div
            style={{
              background: PALETTE.card,
              borderRadius: "12px",
              padding: "20px",
              maxWidth: 280,
              textAlign: "center",
              border: `1.5px solid ${PALETTE.line}`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                fontWeight: 700,
                fontSize: "15px",
                color: PALETTE.ink,
                marginBottom: "8px",
              }}
            >
              Remove user?
            </div>
            <div
              style={{
                fontSize: "13px",
                color: PALETTE.inkSoft,
                marginBottom: "16px",
              }}
            >
              This user will no longer be able to log in, but their purchase
              history will remain.
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={() => setToDelete(null)}
                style={{
                  flex: 1,
                  border: `1px solid ${PALETTE.line}`,
                  background: PALETTE.card,
                  color: PALETTE.ink,
                  fontWeight: 600,
                  fontSize: "13px",
                  padding: "8px",
                  borderRadius: "6px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(toDelete)}
                style={{
                  flex: 1,
                  border: "none",
                  background: PALETTE.rust,
                  color: "#fff",
                  fontWeight: 600,
                  fontSize: "13px",
                  padding: "8px",
                  borderRadius: "6px",
                  cursor: "pointer",
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ManageView({ items, onAddItem, onRemoveItem }) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Kitchen");
  const [recurrenceDays, setRecurrenceDays] = useState(14);
  const [toDelete, setToDelete] = useState(null);

  const CATEGORIES = ["Kitchen", "Bathroom", "Laundry", "Cleaning", "General"];

  const handleAdd = async () => {
    if (!name.trim()) return;
    const newItem = {
      id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: name.trim(),
      category,
      recurrenceDays: parseInt(recurrenceDays, 10),
    };
    await onAddItem(newItem);
    setName("");
    setCategory("Kitchen");
    setRecurrenceDays(14);
    setShowForm(false);
  };

  const handleDelete = async (itemId) => {
    await onRemoveItem(itemId);
    setToDelete(null);
  };

  return (
    <div style={{ padding: "18px 20px", maxWidth: 600 }}>
      <div style={{ marginBottom: "20px" }}>
        <button
          onClick={() => setShowForm(!showForm)}
          style={{
            border: "none",
            background: PALETTE.forest,
            color: "#fff",
            fontWeight: 700,
            fontSize: "13px",
            padding: "12px 16px",
            borderRadius: "9px",
            cursor: "pointer",
            width: "100%",
            transition: "background 0.2s ease",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#0d3821")}
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = PALETTE.forest)
          }
        >
          {showForm ? "Cancel" : "+ Add new item"}
        </button>
      </div>

      {showForm && (
        <div
          style={{
            background: PALETTE.card,
            border: `1.5px dashed ${PALETTE.line}`,
            borderRadius: "12px",
            padding: "16px",
            marginBottom: "20px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <div>
            <label
              style={{
                display: "block",
                fontSize: "12px",
                fontWeight: 700,
                color: PALETTE.inkSoft,
                marginBottom: "4px",
                textTransform: "uppercase",
              }}
            >
              Item name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Aluminum Foil"
              style={{
                width: "100%",
                padding: "10px 12px",
                border: `1px solid ${PALETTE.line}`,
                borderRadius: "8px",
                fontSize: "14px",
                fontFamily: "'DM Sans', sans-serif",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: "block",
                fontSize: "12px",
                fontWeight: 700,
                color: PALETTE.inkSoft,
                marginBottom: "4px",
                textTransform: "uppercase",
              }}
            >
              Category
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={{
                width: "100%",
                padding: "10px 12px",
                border: `1px solid ${PALETTE.line}`,
                borderRadius: "8px",
                fontSize: "14px",
                fontFamily: "'DM Sans', sans-serif",
                boxSizing: "border-box",
              }}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              style={{
                display: "block",
                fontSize: "12px",
                fontWeight: 700,
                color: PALETTE.inkSoft,
                marginBottom: "4px",
                textTransform: "uppercase",
              }}
            >
              Restocks every {recurrenceDays} days
            </label>
            <input
              type="range"
              min="1"
              max="90"
              value={recurrenceDays}
              onChange={(e) => setRecurrenceDays(e.target.value)}
              style={{
                width: "100%",
                cursor: "pointer",
              }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "11px",
                color: PALETTE.inkSoft,
                marginTop: "4px",
              }}
            >
              <span>Weekly</span>
              <span>Monthly</span>
              <span>Quarterly</span>
            </div>
          </div>

          <button
            onClick={handleAdd}
            style={{
              border: "none",
              background: PALETTE.forest,
              color: "#fff",
              fontWeight: 700,
              fontSize: "13px",
              padding: "10px",
              borderRadius: "8px",
              cursor: "pointer",
              marginTop: "4px",
            }}
          >
            Add to list
          </button>
        </div>
      )}

      <section>
        <SectionLabel>Current items ({items.length})</SectionLabel>
        <div
          style={{
            marginTop: "12px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          {items.length === 0 ? (
            <div
              style={{
                padding: "16px",
                color: PALETTE.inkSoft,
                textAlign: "center",
                fontSize: "13px",
              }}
            >
              No items yet. Add one to get started.
            </div>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                style={{
                  background: PALETTE.card,
                  border: `1px solid ${PALETTE.line}`,
                  borderRadius: "10px",
                  padding: "12px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "10px",
                }}
              >
                <div>
                  <div
                    style={{
                      fontWeight: 700,
                      fontSize: "14px",
                      color: PALETTE.ink,
                    }}
                  >
                    {item.name}
                  </div>
                  <div style={{ fontSize: "11px", color: PALETTE.inkSoft }}>
                    {item.category} · every {item.recurrenceDays} days
                  </div>
                </div>
                <button
                  onClick={() => setToDelete(item.id)}
                  style={{
                    border: "1px solid #FCEBE3",
                    background: "#FCEBE3",
                    color: PALETTE.rust,
                    fontWeight: 600,
                    fontSize: "12px",
                    padding: "6px 10px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  Remove
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      {toDelete && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
            zIndex: 1000,
          }}
          onClick={() => setToDelete(null)}
        >
          <div
            style={{
              background: PALETTE.card,
              borderRadius: "12px",
              padding: "20px",
              maxWidth: 280,
              textAlign: "center",
              border: `1.5px solid ${PALETTE.line}`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                fontWeight: 700,
                fontSize: "15px",
                color: PALETTE.ink,
                marginBottom: "8px",
              }}
            >
              Remove item?
            </div>
            <div
              style={{
                fontSize: "13px",
                color: PALETTE.inkSoft,
                marginBottom: "16px",
              }}
            >
              This will delete the item and all its purchase history.
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={() => setToDelete(null)}
                style={{
                  flex: 1,
                  border: `1px solid ${PALETTE.line}`,
                  background: PALETTE.card,
                  color: PALETTE.ink,
                  fontWeight: 600,
                  fontSize: "13px",
                  padding: "8px",
                  borderRadius: "6px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(toDelete)}
                style={{
                  flex: 1,
                  border: "none",
                  background: PALETTE.rust,
                  color: "#fff",
                  fontWeight: 600,
                  fontSize: "13px",
                  padding: "8px",
                  borderRadius: "6px",
                  cursor: "pointer",
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GoogleFonts() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Archivo+Black&family=DM+Sans:wght@400;500;700&family=IBM+Plex+Mono:wght@400;600&display=swap');
    `}</style>
  );
}
