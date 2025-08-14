// src/pages/SelectServices.jsx
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../firebase";
import { useNavigate } from "react-router-dom";
import { useBooking } from "../context/BookingContext";
import { useAuth } from "../context/AuthContext";

/* -------- helpers -------- */
const num = (v) =>
  v == null || v === ""
    ? null
    : Number(typeof v === "string" ? v.replace(/[^\d]/g, "") : v);

const money = (v) =>
  v == null || v === ""
    ? ""
    : new Intl.NumberFormat("sr-RS", {
        style: "currency",
        currency: "RSD",
        maximumFractionDigits: 0,
      }).format(Number(v));

const basePriceOf = (s) =>
  num(s?.basePrice ?? s?.price ?? s?.cena ?? s?.priceRSD ?? s?.cost);

const discountOf = (s) => {
  const d = num(s?.discountPercent);
  if (d == null || !Number.isFinite(d)) return 0;
  return Math.max(0, Math.min(100, d));
};

const finalPriceOf = (s) => {
  const base = basePriceOf(s);
  if (base == null) return null;
  const d = discountOf(s);
  return Math.round((base * (100 - d)) / 100);
};

/* -------- component -------- */
export default function SelectServices() {
  const { user } = useAuth(); // (nije obavezno, ali ostavljeno ako zatreba)
  const { selectedServices, setSelectedServices } = useBooking();
  const [categories, setCategories] = useState([]);
  const [services, setServices] = useState([]);
  const [activeCatId, setActiveCatId] = useState("");
  const [search, setSearch] = useState("");
  const navigate = useNavigate();

  // responsive flag (telefon vs desktop)
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined"
      ? window.matchMedia("(max-width: 768px)").matches
      : false
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 768px)");
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener?.("change", onChange);
    mq.addListener?.(onChange); // stariji Safari
    return () => {
      mq.removeEventListener?.("change", onChange);
      mq.removeListener?.(onChange);
    };
  }, []);

  // snapshots
  useEffect(() => {
    const offC = onSnapshot(
      query(collection(db, "categories"), orderBy("order", "asc")),
      (s) => setCategories(s.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
    const offS = onSnapshot(
      query(collection(db, "services"), orderBy("order", "asc")),
      (s) => setServices(s.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
    return () => {
      offC();
      offS();
    };
  }, []);

  // map usluga po kategoriji
  const servicesByCat = useMemo(() => {
    const m = new Map();
    for (const s of services) {
      const cid = s.categoryId || "__none__";
      if (!m.has(cid)) m.set(cid, []);
      m.get(cid).push(s);
    }
    for (const [k, arr] of m) {
      arr.sort(
        (a, b) =>
          (a.order ?? 0) - (b.order ?? 0) ||
          String(a.name || "").localeCompare(String(b.name || ""))
      );
      m.set(k, arr);
    }
    return m;
  }, [services]);

  const cats = useMemo(
    () => categories.filter((c) => (servicesByCat.get(c.id) || []).length),
    [categories, servicesByCat]
  );

  useEffect(() => {
    if (!activeCatId && cats.length) setActiveCatId(cats[0].id);
  }, [cats, activeCatId]);

  const shown = useMemo(() => {
    let arr = servicesByCat.get(activeCatId) || [];
    const q = search.trim().toLowerCase();
    if (q) arr = arr.filter((s) => String(s.name || "").toLowerCase().includes(q));
    return arr;
  }, [servicesByCat, activeCatId, search]);

  // pomoćna za slike kategorija (pokušava više polja, fallback)
  const catImage = (c) =>
    c?.image || c?.photo || c?.cover || c?.img || "/slika3.webp";

  function toggle(id) {
    const exists = selectedServices.find((x) => x.id === id);
    if (exists) {
      setSelectedServices(selectedServices.filter((x) => x.id !== id));
      return;
    }
    if (selectedServices.length >= 5) {
      alert("Maksimalno 5 usluga.");
      return;
    }
    const srv = services.find((s) => s.id === id);
    if (srv) {
      setSelectedServices([
        ...selectedServices,
        {
          id: srv.id,
          name: srv.name,
          durationMin: Number(srv.durationMin || 0),
          price: finalPriceOf(srv), // čuvamo FINALNU cenu (sa popustom)
          basePrice: basePriceOf(srv) ?? null,
          discountPercent: discountOf(srv),
          categoryId: srv.categoryId || null,
          color: srv.color || null,
        },
      ]);
    }
  }

  const totalMin = selectedServices.reduce((a, b) => a + Number(b.durationMin || 0), 0);
  const totalPrice = selectedServices.reduce((a, b) => a + Number(b.price || 0), 0);
  const canContinue = selectedServices.length >= 1 && selectedServices.length <= 5;

  return (
    <div style={wrap}>
      <div style={panel}>
        {/* header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2 style={title}>Izaberi usluge</h2>
            <div style={{ color: "#fff", opacity: 0.9 }}>
              Min 1, maksimalno 5. Prvo odaberi kategoriju, pa čekiraj usluge.
            </div>
          </div>
          <div style={{ minWidth: 280, flex: "0 1 320px" }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Pretraga usluga…"
              style={searchInp}
            />
          </div>
        </div>

        {/* Kategorije */}
        {isMobile ? (
          // MOBILE: kartice kao na dizajnu
          <div style={mobCatList}>
            {cats.map((c) => {
              const active = c.id === activeCatId;
              return (
                <button
                  key={c.id}
                  onClick={() => setActiveCatId(c.id)}
                  style={mobCatCard(catImage(c), active)}
                >
                  <span style={mobCatLabel}>{String(c.name || "").toUpperCase()}</span>
                </button>
              );
            })}
          </div>
        ) : (
          // DESKTOP: postojeća velika dugmad
          <div style={bigCatsRow}>
            {cats.map((c) => {
              const active = c.id === activeCatId;
              return (
                <button
                  key={c.id}
                  onClick={() => setActiveCatId(c.id)}
                  style={bigCatBtn(active)}
                >
                  {c.name}
                </button>
              );
            })}
          </div>
        )}

        {/* Lista usluga u aktivnoj kategoriji */}
        <div style={srvGrid(isMobile)}>
          {shown.map((s) => {
            const checked = !!selectedServices.find((x) => x.id === s.id);
            const base = basePriceOf(s);
            const disc = discountOf(s);
            const price = finalPriceOf(s);
            return (
              <label key={s.id} style={srvCard(checked)}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(s.id)}
                  style={{ display: "none" }}
                />
                <div style={{ fontWeight: 900, lineHeight: 1.3 }}>{s.name}</div>
                <div
                  style={{
                    fontSize: 12,
                    opacity: 0.9,
                    marginTop: 6,
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <span>{Number(s.durationMin || 0)} min</span>
                  {price != null && (
                    <>
                      <span>•</span>
                      {disc > 0 && base != null ? (
                        <>
                          <span
                            style={{
                              textDecoration: "line-through",
                              opacity: 0.7,
                            }}
                          >
                            {money(base)}
                          </span>
                          <b>{money(price)}</b>
                          <span style={badgeSale}>-{disc}%</span>
                        </>
                      ) : (
                        <b>{money(price)}</b>
                      )}
                    </>
                  )}
                </div>
              </label>
            );
          })}
          {!shown.length && (
            <div style={{ gridColumn: "1/-1", color: "#fff", opacity: 0.9 }}>
              Nema usluga u ovoj kategoriji.
            </div>
          )}
        </div>

        {/* Sažetak + Nastavi */}
        <div style={summaryRow}>
          <div style={{ color: "#fff" }}>
            Izabrano: <b>{selectedServices.length}</b> • Trajanje: <b>{totalMin} min</b>
            {totalPrice ? (
              <>
                {" "}
                • Ukupno: <b>{money(totalPrice)}</b>
              </>
            ) : null}
          </div>
          <button
            disabled={!canContinue}
            onClick={() => navigate("/rezervisi")}
            style={primaryBtn(canContinue)}
          >
            Nastavi
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------- styles -------- */
const wrap = {
  minHeight: "100vh",
  background: "url('/slika7.webp') center/cover fixed no-repeat",
  padding: 18,
  display: "flex",
  justifyContent: "center",
  alignItems: "flex-start",
};
const panel = {
  width: "min(1200px, 100%)",
  background: "rgba(255,255,255,.12)",
  border: "1px solid rgba(255,255,255,.35)",
  backdropFilter: "blur(10px)",
  borderRadius: 28,
  boxShadow: "0 24px 60px rgba(0,0,0,.25)",
  padding: "clamp(16px,3vw,24px)",
};
const title = { margin: 0, color: "#fff", textShadow: "0 2px 14px rgba(0,0,0,.25)" };
const searchInp = {
  height: 42,
  width: "100%",
  borderRadius: 12,
  border: "1px solid #ececec",
  background: "#fff",
  padding: "0 12px",
  fontSize: 14,
};

/* ===== DESKTOP categories (existing) ===== */
const bigCatsRow = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))",
  gap: 10,
  margin: "12px 0 14px",
};
const bigCatBtn = (active) => ({
  height: 64,
  borderRadius: 16,
  border: active ? "none" : "1px solid rgba(255,255,255,.6)",
  background: active
    ? "linear-gradient(135deg,#ff5fa2,#ff7fb5)"
    : "rgba(255,255,255,.15)",
  color: "#fff",
  fontWeight: 900,
  cursor: "pointer",
  boxShadow: active ? "0 8px 20px rgba(255,127,181,.28)" : "none",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
});

/* ===== MOBILE category tiles ===== */
const mobCatList = {
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: 12,
  margin: "12px 0 16px",
};
const mobCatCard = (imgUrl, active) => ({
  position: "relative",
  display: "block",
  width: "100%",
  height: 96,
  borderRadius: 18,
  border: "none",
  overflow: "hidden",
  cursor: "pointer",
  boxShadow: "0 10px 24px rgba(0,0,0,.18)",
  background: `
    linear-gradient(180deg, rgba(255,255,255,0) 40%, rgba(0,0,0,.28) 100%),
    linear-gradient(0deg, rgba(0,0,0,.20), rgba(0,0,0,.20)),
    url('${imgUrl}') center/cover no-repeat
  `,
  WebkitMaskImage: "-webkit-radial-gradient(white, black)",
  isolation: "isolate",
  ...(active && {
    outline: "2px solid rgba(255,127,181,.9)",
    outlineOffset: 0,
  }),
});
const mobCatLabel = {
  position: "absolute",
  right: 16,
  top: "50%",
  transform: "translateY(-50%)",
  background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)",
  color: "#fff",
  padding: "10px 14px",
  borderRadius: 14,
  fontWeight: 900,
  letterSpacing: ".12em",
  fontSize: 13,
  boxShadow: "0 8px 18px rgba(255,127,181,.28)",
};

/* ===== Services grid & cards ===== */
const srvGrid = (mobile) => ({
  display: "grid",
  gridTemplateColumns: mobile ? "1fr" : "repeat(auto-fill,minmax(260px,1fr))",
  gap: 10,
});
const srvCard = (checked) => ({
  borderRadius: 16,
  border: "1px solid rgba(255,255,255,.35)",
  background: checked
    ? "linear-gradient(135deg,#ffffff,#ffe3ef)"
    : "rgba(255,255,255,.92)",
  padding: 14,
  color: "#222",
  boxShadow: checked ? "0 10px 22px rgba(0,0,0,.18)" : "0 6px 16px rgba(0,0,0,.12)",
  cursor: "pointer",
});

const badgeSale = {
  background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)",
  color: "#fff",
  borderRadius: 999,
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 900,
};

const summaryRow = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 10,
  marginTop: 14,
  flexWrap: "wrap",
};
const primaryBtn = (on) => ({
  height: 40,
  borderRadius: 12,
  border: "none",
  padding: "0 16px",
  fontWeight: 900,
  cursor: on ? "pointer" : "not-allowed",
  background: on ? "linear-gradient(135deg,#ff5fa2,#ff7fb5)" : "#ccc",
  color: "#fff",
  boxShadow: on ? "0 8px 20px rgba(255,127,181,.28)" : "none",
});
