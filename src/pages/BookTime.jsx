// src/pages/BookTime.jsx
import { useEffect, useMemo, useState } from "react";
import { useBooking } from "../context/BookingContext";
import { useAuth } from "../context/AuthContext";
import { db } from "../firebase";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
  getDocs,
  addDoc,
  serverTimestamp,
} from "firebase/firestore";

/* ---------- helpers ---------- */
const pad2 = (n) => String(n).padStart(2, "0");
const dateKey = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const ymStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const timeToMin = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map((x) => parseInt(x || 0, 10));
  return (h || 0) * 60 + (m || 0);
};
const minToTime = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
const overlaps = (aS, aE, bS, bE) => Math.max(aS, bS) < Math.min(aE, bE);

const num = (v) =>
  v == null || v === ""
    ? null
    : Number(typeof v === "string" ? v.replace(/[^\d]/g, "") : v);
const basePriceOf = (s) =>
  num(s?.basePrice ?? s?.price ?? s?.cena ?? s?.priceRSD ?? s?.cost);
const discountOf = (s) => {
  const d = num(s?.discountPercent);
  if (!Number.isFinite(d)) return 0;
  return Math.max(0, Math.min(100, d));
};
const finalPriceOf = (s) => {
  const b = basePriceOf(s);
  if (b == null) return null;
  return Math.round((b * (100 - discountOf(s))) / 100);
};
const money = (v) =>
  v == null || v === ""
    ? ""
    : new Intl.NumberFormat("sr-RS", {
        style: "currency",
        currency: "RSD",
        maximumFractionDigits: 0,
      }).format(Number(v));

function computeSlots({ segments, busy, totalMin, step = 15 }) {
  const res = [];
  const segs = (segments || [])
    .map((s) => ({ start: timeToMin(s.start), end: timeToMin(s.end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const taken = (busy || [])
    .map((b) => ({ start: b.startMin, end: b.endMin }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);

  for (const seg of segs) {
    let cur = seg.start;
    for (const b of taken) {
      if (b.end <= seg.start || b.start >= seg.end) continue;
      const freeEnd = Math.min(b.start, seg.end);
      for (let t = cur; t + totalMin <= freeEnd; t += step)
        res.push({ startMin: t, endMin: t + totalMin });
      cur = Math.max(cur, b.end);
    }
    for (let t = cur; t + totalMin <= seg.end; t += step)
      res.push({ startMin: t, endMin: t + totalMin });
  }
  return res;
}

/* ---------- component ---------- */
export default function BookTime() {
  const { selectedServices } = useBooking();
  const { user } = useAuth();

  const [employees, setEmployees] = useState([]);
  const [activeId, setActiveId] = useState(selectedServices[0]?.id || "");
  const [monthAnchor, setMonthAnchor] = useState(ymStr(new Date()));
  const [selectedDay, setSelectedDay] = useState(() => new Date());

  // per-service preferencije
  const [prefs, setPrefs] = useState(() => {
    const m = new Map();
    selectedServices.forEach((s) =>
      m.set(s.id, { mode: "any", empId: "", booked: false })
    );
    return m;
  });

  useEffect(() => {
    const offE = onSnapshot(
      query(collection(db, "employees"), orderBy("name", "asc")),
      (s) => setEmployees(s.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
    return () => offE();
  }, []);

  if (!selectedServices.length) {
    return (
      <div style={wrap}>
        <div style={panel}>
          <h2 style={title}>Nema izabranih usluga</h2>
          <div style={{ color: "#fff" }}>Vrati se i izaberi do 5 usluga.</div>
        </div>
      </div>
    );
  }

  const activeService =
    selectedServices.find((s) => s.id === activeId) || selectedServices[0];
  const p =
    prefs.get(activeService.id) || { mode: "any", empId: "", booked: false };

  const eligible = useMemo(() => {
    if (!activeService) return [];
    const cid = activeService.categoryId;
    return employees.filter((e) => {
      const srv = new Set(e.services || []);
      const cat = new Set(e.categories || []);
      return srv.has(activeService.id) || (cid && cat.has(cid));
    });
  }, [employees, activeService]);

  const [slotsByEmp, setSlotsByEmp] = useState(new Map());
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState(false);

  useEffect(() => {
    let cancel = false;
    async function load() {
      if (!activeService) return;
      setLoading(true);
      const dk = dateKey(selectedDay);
      const map = new Map();

      for (const e of eligible) {
        const qS = query(
          collection(db, "shifts"),
          where("dateKey", "==", dk),
          where("employeeId", "==", e.id)
        );
        const sSnap = await getDocs(qS);
        const segments = sSnap.docs.flatMap((d) => d.data().segments || []);
        if (!segments.length) {
          map.set(e.id, []);
          continue;
        }

        const qA = query(
          collection(db, "appointments"),
          where("dateKey", "==", dk),
          where("employeeId", "==", e.id)
        );
        const aSnap = await getDocs(qA);
        const busy = aSnap.docs.map((d) => d.data());

        const slots = computeSlots({
          segments,
          busy,
          totalMin: Number(activeService.durationMin || 0),
          step: 15,
        });
        map.set(e.id, slots);
      }
      if (!cancel) {
        setSlotsByEmp(map);
        setLoading(false);
      }
    }
    load();
    return () => {
      cancel = true;
    };
  }, [selectedDay, eligible, activeService]);

  const combined = useMemo(() => {
    const arr = [];
    for (const [id, slots] of slotsByEmp)
      for (const s of slots) arr.push({ ...s, employeeId: id });
    arr.sort((a, b) => a.startMin - b.startMin);
    return arr;
  }, [slotsByEmp]);

  const currentSlots =
    p.mode === "specific"
      ? (slotsByEmp.get(p.empId) || []).map((s) => ({
          ...s,
          employeeId: p.empId,
        }))
      : combined;

  async function book(slot) {
    if (!user) {
      alert("Prijavi se da bi rezervisao.");
      return;
    }
    if (p.mode === "specific" && !p.empId) {
      alert("Odaberi radnicu.");
      return;
    }

    try {
      setBusyAction(true);

      const emp = employees.find((e) => e.id === slot.employeeId);
      if (!emp) {
        alert("Radnica nije pronađena.");
        return;
      }

      const dk = dateKey(selectedDay);

      // re-check preklapanja
      const qA = query(
        collection(db, "appointments"),
        where("dateKey", "==", dk),
        where("employeeId", "==", emp.id)
      );
      const aSnap = await getDocs(qA);
      const busy = aSnap.docs.map((d) => d.data());
      if (
        busy.some((b) =>
          overlaps(slot.startMin, slot.endMin, b.startMin, b.endMin)
        )
      ) {
        alert("Termin je upravo zauzet. Izaberi drugi.");
        return;
      }

      // payload
      const payload = {
        type: "booking",
        status: "booked",
        employeeId: emp.id,
        employeeName: emp.name || "",
        dateKey: dk,
        startHHMM: minToTime(slot.startMin),
        endHHMM: minToTime(slot.endMin),
        startMin: slot.startMin,
        endMin: slot.endMin,
        durationMin: Number(activeService.durationMin || 0),
        serviceId: activeService.id,
        serviceName: activeService.name,
        price: finalPriceOf(activeService) ?? null,
        clientName: `${user?.firstName || ""} ${user?.lastName || ""}`.trim(),
        clientPhone: user?.phone || "",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        ...(activeService.color ? { color: activeService.color } : {}),
      };

      await addDoc(collection(db, "appointments"), payload);

      // markiraj kao zakazano + pređi na sledeću
      const next = new Map(prefs);
      next.set(activeService.id, { ...p, booked: true });
      setPrefs(next);

      alert("Termin je uspešno rezervisan ❤️");

      const remaining = selectedServices.find((s) => !(next.get(s.id)?.booked));
      if (remaining) setActiveId(remaining.id);
    } catch (err) {
      console.error("Booking error:", err);
      const msg = String(err?.message || "Greška pri rezervaciji.");
      alert(
        msg.includes("index")
          ? "Upit traži Firestore indeks. Otvori konzolu i klikni na link koji je Firestore generisao da napraviš indeks, pa pokušaj ponovo."
          : msg
      );
    } finally {
      setBusyAction(false);
    }
  }

  const allBooked = selectedServices.every((s) => prefs.get(s.id)?.booked);

  return (
    <div style={wrap}>
      <div style={panel}>
        <h2 style={title}>Rezerviši odabrane usluge</h2>

        <div style={layout}>
          {/* leva kolona: usluge */}
          <div style={leftCol}>
            {selectedServices.map((s) => {
              const booked = prefs.get(s.id)?.booked;
              const active = s.id === activeService.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveId(s.id)}
                  style={srvItem(active, booked)}
                  type="button"
                >
                  <div style={{ fontWeight: 900, lineHeight: 1.3 }}>
                    {s.name}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>
                    {Number(s.durationMin || 0)} min{" "}
                    {finalPriceOf(s) != null && <>• {money(finalPriceOf(s))}</>}
                  </div>
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 12,
                      fontWeight: 900,
                      color: booked ? "#1a7f3c" : "#7a1b1b",
                    }}
                  >
                    {booked ? "Zakazano" : "Nije zakazano"}
                  </div>
                </button>
              );
            })}
          </div>

          {/* desna kolona: novi UI */}
          <div style={rightCol}>
            {/* info o usluzi + kontrole (zadržane) */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                alignItems: "end",
              }}
            >
              <div>
                <div style={{ fontSize: 12, opacity: 0.85, color: "#fff" }}>
                  Usluga
                </div>
                <div style={{ fontWeight: 900, color: "#fff" }}>
                  {activeService.name}
                </div>
                <div style={{ fontSize: 12, opacity: 0.9, color: "#fff" }}>
                  Trajanje:{" "}
                  <b>{Number(activeService.durationMin || 0)} min</b>{" "}
                  {finalPriceOf(activeService) != null && (
                    <>
                      • Cena: <b>{money(finalPriceOf(activeService))}</b>
                    </>
                  )}
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3,minmax(150px,1fr))",
                  gap: 8,
                  alignItems: "end",
                }}
              >
                <div>
                  <label style={lbl}>Način izbora</label>
                  <select
                    value={p.mode}
                    onChange={(e) =>
                      setPrefs(
                        new Map(
                          prefs.set(activeService.id, {
                            ...p,
                            mode: e.target.value,
                          })
                        )
                      )
                    }
                    style={inp}
                  >
                    <option value="any">Prva slobodna radnica</option>
                    <option value="specific">Određena radnica</option>
                  </select>
                </div>
                <div>
                  <label style={lbl}>Radnica</label>
                  <select
                    value={p.empId}
                    onChange={(e) =>
                      setPrefs(
                        new Map(
                          prefs.set(activeService.id, {
                            ...p,
                            empId: e.target.value,
                          })
                        )
                      )
                    }
                    disabled={p.mode !== "specific"}
                    style={{
                      ...inp,
                      background: p.mode === "specific" ? "#fff" : "#f3f3f3",
                    }}
                  >
                    <option value="">— Odaberi —</option>
                    {eligible.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={lbl}>Mesec</label>
                  <input
                    type="month"
                    value={monthAnchor}
                    onChange={(e) => {
                      setMonthAnchor(e.target.value);
                      const [y, m] = e.target.value
                        .split("-")
                        .map((n) => parseInt(n, 10));
                      setSelectedDay(new Date(y, m - 1, 1));
                    }}
                    style={inp}
                  />
                </div>
              </div>
            </div>

            {/* 1) traka sa datumima */}
            <DateStrip
              monthStr={monthAnchor}
              selectedDay={selectedDay}
              onSelect={setSelectedDay}
            />

            {/* 2) kartice radnica */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                margin: "4px 2px 8px",
              }}
            >
              <div style={{ color: "#fff", fontWeight: 900 }}>Hair Stylish</div>
              <div style={{ color: "#fff", opacity: 0.85, fontSize: 12 }}>
                See All
              </div>
            </div>

            <div style={stylistsRow}>
              {eligible.length ? (
                eligible.map((e) => {
                  const activeEmp = p.empId === e.id && p.mode === "specific";
                  return (
                    <EmpCard
                      key={e.id}
                      name={e.name}
                      rating={Number(e.rating || 4.7)}
                      active={activeEmp}
                      onClick={() =>
                        setPrefs(
                          new Map(
                            prefs.set(activeService.id, {
                              ...p,
                              mode: "specific",
                              empId: e.id,
                            })
                          )
                        )
                      }
                    />
                  );
                })
              ) : (
                <div style={{ color: "#fff", opacity: 0.85, padding: 8 }}>
                  Nema radnica za ovu uslugu/kategoriju.
                </div>
              )}
            </div>

            {/* 3) available time */}
            <div style={{ color: "#fff", opacity: 0.9, margin: "8px 2px 6px" }}>
              Available Time
            </div>

            <div style={pillsGrid}>
              {loading ? (
                <div style={{ color: "#fff", opacity: 0.9 }}>Učitavam…</div>
              ) : currentSlots.length ? (
                currentSlots.map((s) => {
                  const e = employees.find((x) => x.id === s.employeeId);
                  return (
                    <button
                      key={`${s.employeeId}_${s.startMin}`}
                      style={{
                        ...pillBtn,
                        opacity: busyAction ? 0.7 : 1,
                        pointerEvents: busyAction ? "none" : "auto",
                      }}
                      onClick={() => book(s)}
                      type="button"
                      disabled={busyAction}
                      title={e?.name || "Radnica"}
                    >
                      <div style={{ fontWeight: 800 }}>
                        {minToTime(s.startMin)}
                      </div>
                      {p.mode !== "specific" && (
                        <div style={{ fontSize: 11, opacity: 0.85 }}>
                          {e?.name || "Radnica"}
                        </div>
                      )}
                    </button>
                  );
                })
              ) : (
                <div style={{ color: "#fff", opacity: 0.9 }}>
                  Nema slobodnih termina za izabrani dan.
                </div>
              )}
            </div>

            {allBooked && (
              <div style={{ marginTop: 12, color: "#fff" }}>
                🎉 Sve izabrane usluge su zakazane. Hvala!
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- date strip (horizontalni datumi) ---------- */
function DateStrip({ monthStr, selectedDay, onSelect }) {
  // render 14 dana oko izabranog
  const start = new Date(selectedDay);
  start.setDate(selectedDay.getDate() - 4);
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });

  return (
    <div style={stripWrap}>
      <button
        type="button"
        onClick={() =>
          onSelect(
            new Date(
              selectedDay.getFullYear(),
              selectedDay.getMonth(),
              selectedDay.getDate() - 7
            )
          )
        }
        style={stripArrow}
      >
        ‹
      </button>

      <div style={stripScroller}>
        {days.map((d, idx) => {
          const isSel = dateKey(d) === dateKey(selectedDay);
          const wd = d
            .toLocaleDateString("sr-RS", { weekday: "short" })
            .replace(".", "");
          return (
            <button key={idx} onClick={() => onSelect(d)} type="button" style={stripDay(isSel)}>
              <div style={{ fontSize: 11, opacity: 0.9 }}>{wd}</div>
              <div style={{ fontWeight: 900, fontSize: 16 }}>{d.getDate()}</div>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() =>
          onSelect(
            new Date(
              selectedDay.getFullYear(),
              selectedDay.getMonth(),
              selectedDay.getDate() + 7
            )
          )
        }
        style={stripArrow}
      >
        ›
      </button>
    </div>
  );
}

/* ---------- kartica radnice ---------- */
function EmpCard({ name, rating = 4.7, onClick, active }) {
  const initials = String(name || "?")
    .split(" ")
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <button type="button" onClick={onClick} style={empCard(active)}>
      <div style={empAvatar}>
        {/* kasnije samo zameni sadržaj za <img src="..." alt={name} style={empImg} /> */}
        <div style={empInitials}>{initials}</div>
      </div>
      <div style={{ fontWeight: 700, marginTop: 6, color: "#222" }}>{name}</div>
      <div style={{ fontSize: 12, opacity: 0.9, color: "#555" }}>
        ⭐ {Number(rating).toFixed(1)}
      </div>
    </button>
  );
}

/* ---------- mini monthly calendar (ostavljen ako poželiš i mesečni prikaz) ---------- */
function MiniCalendar({ monthStr, selectedDay, onSelect }) {
  const base = new Date(monthStr + "-01T00:00:00");
  const days = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const startDow = new Date(base.getFullYear(), base.getMonth(), 1).getDay();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);

  return (
    <div style={{ margin: "10px 0 12px" }}>
      <div style={calHeader}>
        {["Ned", "Pon", "Uto", "Sre", "Čet", "Pet", "Sub"].map((d) => (
          <div key={d} style={calHeadCell}>
            {d}
          </div>
        ))}
      </div>
      <div style={calGrid}>
        {cells.map((d, i) => {
          if (!d) return <div key={i} style={calCell} />;
          const k = `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(
            d
          )}`;
          const isSel = dateKey(selectedDay) === k;
          return (
            <button
              key={i}
              style={calBtn(isSel)}
              onClick={() =>
                onSelect(new Date(base.getFullYear(), base.getMonth(), d))
              }
              type="button"
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- styles ---------- */
const wrap = {
  minHeight: "100vh",
  background: "url('/slika7.webp') center/cover fixed no-repeat",
  padding: 18,
  display: "flex",
  justifyContent: "center",
  alignItems: "flex-start",
};
const panel = {
  width: "min(1400px, 100%)",
  background: "rgba(255,255,255,.12)",
  border: "1px solid rgba(255,255,255,.35)",
  backdropFilter: "blur(10px)",
  borderRadius: 28,
  boxShadow: "0 24px 60px rgba(0,0,0,.25)",
  padding: "clamp(16px,3vw,24px)",
};
const title = {
  marginTop: 0,
  color: "#fff",
  textShadow: "0 2px 14px rgba(0,0,0,.25)",
};
const layout = {
  display: "grid",
  gridTemplateColumns: "360px 1fr",
  gap: 12,
};
const leftCol = { display: "grid", gap: 8, alignContent: "start" };
const rightCol = {
  background: "rgba(0,0,0,.35)",
  borderRadius: 16,
  padding: 12,
  border: "1px solid rgba(255,255,255,.2)",
};

/* leva kolona – item usluge */
const srvItem = (active, booked) => ({
  textAlign: "left",
  padding: 12,
  borderRadius: 14,
  border: active ? "none" : "1px solid rgba(255,255,255,.35)",
  background: active
    ? "linear-gradient(135deg,#ff5fa2,#ff7fb5)"
    : "rgba(255,255,255,.15)",
  color: "#fff",
  boxShadow: active ? "0 8px 20px rgba(255,127,181,.28)" : "none",
  cursor: "pointer",
  outline: booked ? "2px solid rgba(26,127,60,.6)" : "none",
});

const lbl = { color: "#fff", fontWeight: 900, fontSize: 12, opacity: 0.95 };
const inp = {
  height: 40,
  borderRadius: 10,
  border: "1px solid #e8e8e8",
  background: "#fff",
  padding: "0 12px",
  fontSize: 14,
  color: "#222",
  width: "100%",
};

/* --- Date strip --- */
const stripWrap = {
  display: "grid",
  gridTemplateColumns: "32px 1fr 32px",
  alignItems: "center",
  gap: 8,
  margin: "12px 0 10px",
};
const stripArrow = {
  height: 32,
  width: 32,
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,.35)",
  background: "rgba(255,255,255,.15)",
  color: "#fff",
  fontSize: 18,
  cursor: "pointer",
};
const stripScroller = {
  display: "grid",
  gridAutoFlow: "column",
  gridAutoColumns: "minmax(60px, 1fr)",
  gap: 8,
  overflowX: "auto",
  padding: "2px 2px",
  scrollbarWidth: "none",
};
const stripDay = (sel) => ({
  display: "grid",
  placeItems: "center",
  gap: 2,
  padding: "8px 6px",
  borderRadius: 12,
  border: sel ? "1px solid #ffcfde" : "1px solid rgba(255,255,255,.35)",
  background: sel ? "linear-gradient(135deg,#ffffff,#ffe3ef)" : "rgba(255,255,255,.12)",
  color: "#fff",
  minWidth: 64,
  cursor: "pointer",
  boxShadow: sel ? "0 6px 16px rgba(255,127,181,.25)" : "none",
});

/* --- Stilisti (radnice) --- */
const stylistsRow = {
  display: "grid",
  gridAutoFlow: "column",
  gridAutoColumns: "minmax(140px, 180px)",
  gap: 10,
  overflowX: "auto",
  paddingBottom: 4,
};
const empCard = (active) => ({
  textAlign: "center",
  padding: 12,
  borderRadius: 16,
  background: "#fff",
  border: active ? "2px solid #eab8c8" : "1px solid #ececec",
  boxShadow: active ? "0 8px 22px rgba(0,0,0,.12)" : "0 4px 12px rgba(0,0,0,.08)",
  cursor: "pointer",
});
const empAvatar = {
  height: 64,
  width: 64,
  borderRadius: "50%",
  background: "linear-gradient(135deg,#ffe9f2,#fff)",
  border: "1px solid #f1d8e0",
  display: "grid",
  placeItems: "center",
  margin: "0 auto",
};
const empInitials = { fontWeight: 900, color: "#b8798e" };
const empImg = { height: "100%", width: "100%", borderRadius: "50%", objectFit: "cover" };

/* --- Pil dugmići vremena --- */
const pillsGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill,minmax(120px,1fr))",
  gap: 8,
};
const pillBtn = {
  display: "grid",
  justifyItems: "center",
  gap: 2,
  padding: "10px 12px",
  borderRadius: 999,
  border: "1px solid #efcddc",
  background: "#fff",
  color: "#222",
  cursor: "pointer",
  boxShadow: "0 6px 16px rgba(0,0,0,.08)",
};

/* --- (opciono) mesečni mini kalendar – ostavljen nepromenjen --- */
const calHeader = {
  display: "grid",
  gridTemplateColumns: "repeat(7,1fr)",
  gap: 6,
  marginTop: 8,
  marginBottom: 6,
};
const calHeadCell = {
  textAlign: "center",
  padding: "6px 8px",
  background: "rgba(255,255,255,.85)",
  borderRadius: 10,
  fontWeight: 900,
  border: "1px solid #ececec",
};
const calGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(7,1fr)",
  gap: 6,
};
const calCell = {
  minHeight: 46,
  borderRadius: 10,
  border: "1px dashed rgba(255,255,255,.35)",
};
const calBtn = (sel) => ({
  minHeight: 46,
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,.35)",
  background: sel
    ? "linear-gradient(135deg,#ffffff,#ffe3ef)"
    : "rgba(255,255,255,.12)",
  color: "#fff",
  fontWeight: 900,
  cursor: "pointer",
});
