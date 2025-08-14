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
  const { user } = useAuth();
  const { selectedServices, setSelectedServices } = useBooking();
  const [categories, setCategories] = useState([]);
  const [services, setServices] = useState([]);
  const [activeCatId, setActiveCatId] = useState("");
  const navigate = useNavigate();

  // responsive flag
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
    mq.addListener?.(onChange);
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

  // helper za sliku kategorije
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
          price: finalPriceOf(srv),
          basePrice: basePriceOf(srv) ?? null,
          discountPercent: discountOf(srv),
          categoryId: srv.categoryId || null,
          color: srv.color || null,
        },
      ]);
    }
  }

  const totalMin = selectedServices.reduce(
    (a, b) => a + Number(b.durationMin || 0),
    0
  );
  const totalPrice = selectedServices.reduce(
    (a, b) => a + Number(b.price || 0),
    0
  );
  const canContinue =
    selectedServices.length >= 1 && selectedServices.length <= 5;

  return (
    <div style={wrap}>
      <div style={panel}>
        {/* header (crna slova) */}
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
            <div style={{ color: "#000", opacity: 0.9 }}>
              Min 1, maksimalno 5. Odaberi kategoriju i čekiraj uslugu.
            </div>
          </div>
          {/* pretraga je uklonjena */}
        </div>

        {/* KATEGORIJE + USLUGE: svaka kategorija renderuje svoje usluge odmah ispod */}
        <div style={catStack}>
          {cats.map((c) => {
            const isActive = c.id === activeCatId;
            const list = servicesByCat.get(c.id) || [];
            return (
              <div key={c.id} style={{ display: "grid", gap: 10 }}>
                {/* Kategorija (tile na mobilu, dugme na desktopu) */}
                {isMobile ? (
                  <button
                    onClick={() => setActiveCatId(c.id)}
                    style={mobCatCard(catImage(c), isActive)}
                  >
                    <span style={mobCatLabel}>
                      {String(c.name || "").toUpperCase()}
                    </span>
                  </button>
                ) : (
                  <button
                    onClick={() => setActiveCatId(c.id)}
                    style={deskCatBtn(isActive)}
                  >
                    {c.name}
                  </button>
                )}

                {/* USLUGE — prikazuju se samo ispod aktivne kategorije */}
                {isActive && (
                  <div style={srvGrid(isMobile)}>
                    {list.map((s) => {
                      const checked = !!selectedServices.find(
                        (x) => x.id === s.id
                      );
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
                          {/* Naziv CENTRIRAN i CRN */}
                          <div
                            style={{
                              fontWeight: 900,
                              lineHeight: 1.3,
                              textAlign: "center",
                              color: "#000",
                            }}
                          >
                            {s.name}
                          </div>
                          {/* Info red CENTRIRAN i CRN */}
                          <div
                            style={{
                              fontSize: 12,
                              marginTop: 6,
                              display: "flex",
                              gap: 8,
                              alignItems: "center",
                              justifyContent: "center",
                              flexWrap: "wrap",
                              color: "#000",
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
                                    <b style={{ color: "#000" }}>
                                      {money(price)}
                                    </b>
                                    <span style={badgeSale}>-{disc}%</span>
                                  </>
                                ) : (
                                  <b style={{ color: "#000" }}>
                                    {money(price)}
                                  </b>
                                )}
                              </>
                            )}
                          </div>
                        </label>
                      );
                    })}
                    {!list.length && (
                      <div
                        style={{
                          gridColumn: "1/-1",
                          color: "#000",
                          opacity: 0.9,
                          textAlign: "center",
                        }}
                      >
                        Nema usluga u ovoj kategoriji.
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Sažetak + Nastavi (crna slova) */}
        <div style={summaryRow}>
          <div style={{ color: "#000" }}>
            Izabrano: <b>{selectedServices.length}</b> • Trajanje:{" "}
            <b>{totalMin} min</b>
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
  background: "rgba(255,255,255,.2)", // svetlije da crni tekst bude čitljiv
  border: "1px solid rgba(255,255,255,.35)",
  backdropFilter: "blur(10px)",
  borderRadius: 28,
  boxShadow: "0 24px 60px rgba(0,0,0,.25)",
  padding: "clamp(16px,3vw,24px)",
};
const title = { margin: 0, color: "#000" };

/* Stog kategorija (svaka sa svojim listom) */
const catStack = {
  display: "grid",
  gap: 16,
  marginTop: 12,
};

/* ===== DESKTOP kategorije (bez roze okvira) ===== */
const deskCatBtn = (active) => ({
  height: 64,
  borderRadius: 16,
  border: "1px solid rgba(0,0,0,.2)",
  background: active ? "rgba(255,255,255,.95)" : "rgba(255,255,255,.85)",
  color: "#000",
  fontWeight: 900,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
});

/* ===== MOBILE category tile ===== (bez outline-a, label crna) */
const mobCatCard = (imgUrl /* , active */) => ({
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
    linear-gradient(180deg, rgba(255,255,255,0) 40%, rgba(0,0,0,.18) 100%),
    url('${imgUrl}') center/cover no-repeat
  `,
  WebkitMaskImage: "-webkit-radial-gradient(white, black)",
  isolation: "isolate",
  // nema roze okvira / outline-a
});
const mobCatLabel = {
  position: "absolute",
  right: 16,
  top: "50%",
  transform: "translateY(-50%)",
  background: "rgba(255,255,255,.92)",
  color: "#000", // crna slova
  padding: "10px 14px",
  borderRadius: 14,
  fontWeight: 900,
  letterSpacing: ".08em",
  fontSize: 13,
  boxShadow: "0 8px 18px rgba(0,0,0,.15)",
};

/* ===== Services grid & cards ===== */
const srvGrid = (mobile) => ({
  display: "grid",
  gridTemplateColumns: mobile ? "1fr" : "repeat(auto-fill,minmax(260px,1fr))",
  gap: 10,
});

// jača boja za checked; sva slova crna
const srvCard = (checked) => ({
  borderRadius: 16,
  border: "1px solid rgba(0,0,0,.15)",
  background: checked ? "#ffb7d0" : "#ffffff", // JAČA nijansa kad je čekirano
  padding: 16,
  color: "#000",
  boxShadow: checked
    ? "0 10px 22px rgba(0,0,0,.20)"
    : "0 6px 16px rgba(0,0,0,.12)",
  cursor: "pointer",
  transition: "background .15s ease, box-shadow .15s ease",
});

const badgeSale = {
  background: "#ffe3ef",
  color: "#000",
  borderRadius: 999,
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 900,
  border: "1px solid rgba(0,0,0,.1)",
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
  border: "1px solid rgba(0,0,0,.15)",
  padding: "0 16px",
  fontWeight: 900,
  cursor: on ? "pointer" : "not-allowed",
  background: on ? "#ffd6e7" : "#eee",
  color: "#000",
  boxShadow: on ? "0 8px 20px rgba(0,0,0,.15)" : "none",
});
