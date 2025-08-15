// src/pages/AdminKlijenti.jsx
import React, { useEffect, useMemo, useState } from "react";
import { db } from "../firebase";
import { collection, onSnapshot, query, orderBy } from "firebase/firestore";

export default function AdminKlijenti() {
  const [clients, setClients] = useState([]);
  const [search, setSearch] = useState("");

  // učitaj jedinstvene klijente iz appointments (bez duplikata po name+phone)
  useEffect(() => {
    const q = query(collection(db, "appointments"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const map = new Map();
      snap.forEach((doc) => {
        const d = doc.data();
        const key = `${(d.clientName || "").trim().toLowerCase()}_${(d.clientPhone || "").trim()}`;
        if (!map.has(key)) {
          map.set(key, {
            name: d.clientName || "Nepoznato",
            phone: d.clientPhone || "",
            lastService: d.serviceName || "",
            lastDate: d.dateKey || "",
          });
        }
      });
      setClients(Array.from(map.values()));
    });
    return unsub;
  }, []);

  // helperi za pretragu
  const normText = (s = "") => s.toString().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const normPhone = (s = "") => s.toString().replace(/[^\d]/g, ""); // samo cifre

  const filtered = useMemo(() => {
    const q = normText(search);
    const qPhone = normPhone(search);
    if (!q && !qPhone) return clients;

    return clients.filter((c) => {
      const name = normText(c.name);
      const phone = normPhone(c.phone);
      const matchName = q ? name.includes(q) : false;
      const matchPhone = qPhone ? phone.includes(qPhone) : false;
      return matchName || matchPhone;
    });
  }, [clients, search]);

  return (
    <div style={wrap}>
      <div style={panel}>
        {/* NASLOV + PRETRAGA */}
        <div style={headRow}>
          <h2 style={title}>Klijenti</h2>
          <div style={searchBox}>
            <input
              style={searchInput}
              placeholder="Pretraga: ime, prezime ili broj"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Pretraga klijenata"
            />
          </div>
        </div>

        <div style={{ background: "#fff", borderRadius: 16, padding: 16, boxShadow: "0 10px 24px rgba(0,0,0,.06)" }}>
          {filtered.length === 0 ? (
            <p style={{ margin: 0, color: "#777" }}>Nema klijenata za zadatu pretragu.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#f6f6f6" }}>
                  <th style={th}>Ime</th>
                  <th style={th}>Telefon</th>
                  <th style={th}>Poslednja usluga</th>
                  <th style={th}>Datum</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c, i) => (
                  <tr key={`${c.phone}-${i}`} style={i % 2 ? { background: "#fafafa" } : undefined}>
                    <td style={tdBold}>{c.name}</td>
                    <td style={td}>{c.phone}</td>
                    <td style={td}>{c.lastService}</td>
                    <td style={td}>{c.lastDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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

const headRow = {
  display: "grid",
  gridTemplateColumns: "1fr 320px",
  gap: 10,
  marginBottom: 12,
};
const title = { margin: 0, color: "#000", fontWeight: 900, fontSize: "clamp(20px,3vw,28px)" };

const searchBox = { display: "grid", alignItems: "center" };
const searchInput = {
  height: 40,
  borderRadius: 12,
  border: "1px solid #e7e7e7",
  padding: "0 12px",
  background: "#fff",
  outline: "none",
  boxShadow: "0 6px 12px rgba(0,0,0,.05)",
  fontSize: 14,
  width: "100%",
};

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

/* responsive: stack naslov i pretragu */
if (typeof window !== "undefined" && window.innerWidth < 700) {
  headRow.gridTemplateColumns = "1fr";
}
