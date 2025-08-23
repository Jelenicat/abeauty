// src/pages/AdminKlijenti.jsx
import React, { useEffect, useMemo, useState } from "react";
import { db } from "../firebase";
import { collection, onSnapshot, query, orderBy } from "firebase/firestore";
import { useNavigate } from "react-router-dom";

/* mali hook za responsive */
function useIsMobile(bp = 700) {
  const [m, setM] = useState(
    typeof window !== "undefined" ? window.innerWidth <= bp : true
  );
  useEffect(() => {
    const onR = () => setM(window.innerWidth <= bp);
    window.addEventListener("resize", onR);
    return () => window.removeEventListener("resize", onR);
  }, [bp]);
  return m;
}

// helperi za pretragu i normalizaciju
const normText = (s = "") =>
  s.toString().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const digits = (s = "") => s.toString().replace(/[^\d]/g, "");

// brojevi koje isključujemo
const EXCLUDE_PHONES = new Set(["0665511005", "0000000000"]);

export default function AdminKlijenti() {
  const [users, setUsers] = useState([]);                // korisnici iz 'users'
  const [lastByPhone, setLastByPhone] = useState({});    // tel -> { lastService, lastDate }
  const [apptOnlyClients, setApptOnlyClients] = useState({}); // telDigits -> { uid, name, phone, role, createdAt }
  const [search, setSearch] = useState("");
  const isMobile = useIsMobile(700);
  const nav = useNavigate();

  // 1) UČITAJ SVE KORISNIKE IZ 'users' (bez admin/abeauty)
  useEffect(() => {
    const qUsers = query(collection(db, "users"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(qUsers, (snap) => {
      const list = [];
      snap.forEach((doc) => {
        const d = doc.data() || {};
        const phoneRaw = d.phone || "";
        const phoneDigits = digits(phoneRaw);

        // isključi ova dva broja
        if (EXCLUDE_PHONES.has(phoneDigits)) return;

        list.push({
          uid: doc.id,
          name:
            [d.firstName, d.lastName].filter(Boolean).join(" ").trim() ||
            d.firstName ||
            d.lastName ||
            "—",
          phone: phoneRaw || "",
          role: d.role || "",
          isAdmin: !!d.isAdmin,
          isFinance: !!d.isFinance,
          createdAt: d.createdAt || null,
        });
      });
      setUsers(list);
    });
    return unsub;
  }, []);

  // 2) UČITAJ IZ 'appointments':
  //    - poslednja usluga/datum po telefonu (lastByPhone)
  //    - "appt-only" klijente (oni koji NISU u users), da ih prikažemo u listi
  useEffect(() => {
    const qAppts = query(collection(db, "appointments"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(qAppts, (snap) => {
      const lastMap = new Map();         // phoneDigits -> { lastService, lastDate }
      const apptClientsMap = new Map();  // phoneDigits -> { uid, name, phone, role, createdAt }

      snap.forEach((doc) => {
        const a = doc.data() || {};
        const phoneRaw = a.clientPhone || "";
        const ph = digits(phoneRaw);
        if (!ph) return;
        if (EXCLUDE_PHONES.has(ph)) return;

        // poslednja usluga/datum (prvi put viđen u sortiranom silazno = newest)
        if (!lastMap.has(ph)) {
          lastMap.set(ph, {
            lastService: a.serviceName || "",
            lastDate: a.dateKey || "",
          });
        }

        // pripremi "appt-only" klijenta (ako se kasnije ispostavi da je u users, nećemo ga duplirati)
        if (!apptClientsMap.has(ph)) {
          const guessedName =
            a.clientName?.toString().trim() ||
            a.name?.toString().trim() ||
            "—";
          apptClientsMap.set(ph, {
            uid: `appt:${ph}`,
            name: guessedName,
            phone: phoneRaw || ph,
            role: "client",
            createdAt: null,
            source: "appointments",
          });
        }
      });

      setLastByPhone(Object.fromEntries(lastMap));
      setApptOnlyClients(Object.fromEntries(apptClientsMap));
    });
    return unsub;
  }, []);

  // 3) Napravi set brojeva koji su već prisutni u users
  const userPhonesSet = useMemo(() => {
    const s = new Set();
    users.forEach((u) => {
      const ph = digits(u.phone);
      if (ph) s.add(ph);
    });
    return s;
  }, [users]);

  // 4) Sastavi finalnu listu:
  //    - svi iz users
  //    - plus svi "appt-only" koji NISU u users (po telefonu)
  const unified = useMemo(() => {
    const base = [...users];
    Object.entries(apptOnlyClients).forEach(([ph, c]) => {
      if (!userPhonesSet.has(ph)) {
        base.push(c);
      }
    });
    return base;
  }, [users, apptOnlyClients, userPhonesSet]);

  // 5) Spoji sa poslednjim terminom (ako postoji)
  const merged = useMemo(() => {
    return unified.map((u) => {
      const info = lastByPhone[digits(u.phone)] || { lastService: "", lastDate: "" };
      return { ...u, ...info };
    });
  }, [unified, lastByPhone]);

  // 6) Pretraga po imenu i/ili broju
  const filtered = useMemo(() => {
    const q = normText(search);
    const qPhone = digits(search);
    if (!q && !qPhone) return merged;

    return merged.filter((c) => {
      const name = normText(c.name);
      const phone = digits(c.phone);
      const matchName = q ? name.includes(q) : false;
      const matchPhone = qPhone ? phone.includes(qPhone) : false;
      return matchName || matchPhone;
    });
  }, [merged, search]);

  return (
    <div style={wrap}>
      {/* malo CSS-a samo za kartice i wrap tabele */}
      <style>{css}</style>

      <div style={panel}>
        {/* Dugme Nazad */}
        <button
          onClick={() => nav(-1)}
          style={backBtn}
          aria-label="Vrati se na prethodnu stranu"
        >
          ← Nazad
        </button>

        {/* NASLOV + PRETRAGA */}
        <div style={headRow(isMobile)}>
          <h2 style={title}>Klijenti</h2>
          <div style={searchBox}>
            <input
              style={searchInput(isMobile)}
              placeholder="Pretraga: ime, prezime ili broj"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Pretraga klijenata"
            />
          </div>
        </div>

        <div
          style={{
            background: "#fff",
            borderRadius: 16,
            padding: isMobile ? 12 : 16,
            boxShadow: "0 10px 24px rgba(0,0,0,.06)",
          }}
        >
          {filtered.length === 0 ? (
            <p style={{ margin: 0, color: "#777" }}>Nema klijenata za zadatu pretragu.</p>
          ) : isMobile ? (
            // 📱 MOBILNI PRIKAZ — kartice
            <div className="clients-cards">
              {filtered.map((c) => (
                <div key={c.uid} className="client-card">
                  <div className="client-name">
                    {c.name}
                    {c.source === "appointments" ? (
                      <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 800, color: "#888" }}>
                        (kal.)
                      </span>
                    ) : null}
                  </div>
                  <div className="client-row">
                    <span className="label">Telefon</span>
                    <span className="value">{c.phone || "—"}</span>
                  </div>
                  <div className="client-row">
                    <span className="label">Uloga</span>
                    <span className="value">{c.role || "client"}</span>
                  </div>
                  <div className="client-row">
                    <span className="label">Usluga</span>
                    <span className="value">{c.lastService || "—"}</span>
                  </div>
                  <div className="client-row">
                    <span className="label">Datum</span>
                    <span className="value">{c.lastDate || "—"}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            // 💻 DESKTOP — tabela
            <div className="clients-table-wrap">
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
                <thead>
                  <tr style={{ background: "#f6f6f6" }}>
                    <th style={th}>Ime</th>
                    <th style={th}>Telefon</th>
                    <th style={th}>Uloga</th>
                    <th style={th}>Poslednja usluga</th>
                    <th style={th}>Datum</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((c, i) => (
                    <tr key={c.uid} style={i % 2 ? { background: "#fafafa" } : undefined}>
                      <td style={tdBold}>
                        {c.name}
                        {c.source === "appointments" ? (
                          <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 800, color: "#888" }}>
                            (kal.)
                          </span>
                        ) : null}
                      </td>
                      <td style={td}>{c.phone}</td>
                      <td style={td}>{c.role || "client"}</td>
                      <td style={td}>{c.lastService}</td>
                      <td style={td}>{c.lastDate}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ===== STILOVI (inline objekti) ===== */
const wrap = {
  minHeight: "100vh",
  background: "url('/slika1.webp') center/cover no-repeat fixed",
  padding: 24,
  display: "flex",
  justifyContent: "center",
  alignItems: "flex-start",
};

const panel = {
  width: "min(1000px, 100%)",
  background: "rgba(255,255,255,.14)",
  border: "1px solid rgba(255,255,255,.35)",
  backdropFilter: "blur(10px)",
  borderRadius: 28,
  boxShadow: "0 24px 60px rgba(0,0,0,.25)",
  padding: "clamp(16px,4vw,28px)",
};

const backBtn = {
  marginBottom: 16,
  padding: "8px 16px",
  borderRadius: 10,
  border: "none",
  background: "#ff69b4",
  color: "#fff",
  fontWeight: 800,
  cursor: "pointer",
  boxShadow: "0 6px 14px rgba(0,0,0,.12)",
  WebkitTapHighlightColor: "transparent",
};

const headRow = (mobile) => ({
  display: "grid",
  gridTemplateColumns: mobile ? "1fr" : "1fr 320px",
  gap: 10,
  marginBottom: 12,
});
const title = { margin: 0, color: "#000", fontWeight: 900, fontSize: "clamp(20px,3vw,28px)" };

const searchBox = { display: "grid", alignItems: "center" };
const searchInput = (mobile) => ({
  height: mobile ? 44 : 40,
  borderRadius: 12,
  border: "1px solid #e7e7e7",
  padding: "0 12px",
  background: "#fff",
  outline: "none",
  boxShadow: "0 6px 12px rgba(0,0,0,.05)",
  fontSize: mobile ? 15 : 14,
  width: "100%",
  WebkitAppearance: "none",
  appearance: "none",
});

/* tabela */
const th = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "1px solid #eaeaea",
  fontWeight: 800,
  color: "#333",
  fontSize: 13,
};
const td = { padding: "10px 12px", borderBottom: "1px solid #f1f1f1", color: "#222" };
const tdBold = { ...td, fontWeight: 800 };

/* malo CSS-a za mobile kartice i wrap tabele */
const css = `
.clients-table-wrap { overflow-x: auto; }

.clients-cards {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}
.client-card {
  border: 1px solid #efefef;
  border-radius: 14px;
  background: #fff;
  padding: 12px;
  box-shadow: 0 8px 18px rgba(0,0,0,.06);
}
.client-name {
  font-weight: 900;
  font-size: 16px;
  margin-bottom: 6px;
  color: #222;
}
.client-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 0;
  border-top: 1px dashed #eee;
}
.client-row:first-of-type { border-top: 0; }
.client-row .label { color: #666; font-weight: 700; font-size: 12px; }
.client-row .value { color: #222; font-weight: 700; font-size: 13px; }
`;
