import React, { useEffect, useMemo, useState } from "react";
import { db } from "../firebase";
import {
  collection, getDocs, query, where, orderBy, limit,
} from "firebase/firestore";

/* ---------- Normalizacija broja ---------- */
function toDigits(s){ return String(s||"").replace(/\D+/g, ""); }
function toE164OrNull(raw){
  const d = toDigits(raw);
  if (!d) return null;
  if (d.startsWith("381")) return "+" + d;
  if (d.startsWith("06")) return "+381" + d.slice(1);
  if (d.startsWith("00")) return "+" + d.slice(2);
  if (raw.startsWith("+")) return raw;
  return null;
}
function toLocal06(raw){
  const d = toDigits(raw);
  if (d.startsWith("381") && d.length >= 11) return "0" + d.slice(3);
  if (d.startsWith("06")) return "0" + d.slice(1);
  return null;
}
function phoneVariants(raw){
  const set = new Set();
  const trimmed = String(raw||"").trim();
  if (trimmed) set.add(trimmed);
  const e164 = toE164OrNull(trimmed);
  if (e164) set.add(e164);
  const local06 = toLocal06(trimmed);
  if (local06) set.add(local06);
  for (const v of Array.from(set)) set.add(v.replace(/\s|-/g,""));
  return Array.from(set).filter(Boolean).slice(0, 10);
}

export default function ClientStatsPrompt({ phone, name, onClose }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);   // svi termini za statistiku
  const [last, setLast] = useState([]);   // poslednjih 5 termina

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        setLoading(true);
        const variants = phoneVariants(phone);
        const col = collection(db, "appointments");

        if (!variants.length && !name) {
          setRows([]); setLast([]); return;
        }

        // 1️⃣ Svi termini (bez orderBy da ne traži indeks)
        const allQuery = variants.length
          ? query(col, where("clientPhone", "in", variants))
          : query(col, where("clientName", "==", name));
        const snapAll = await getDocs(allQuery);
        if (dead) return;
        const allDocs = [];
        snapAll.forEach(doc => allDocs.push({ id: doc.id, ...doc.data() }));
        setRows(allDocs);

        // 2️⃣ Poslednjih 5 termina (sortirano po datumu)
        const fiveQuery = variants.length
          ? query(col, where("clientPhone", "in", variants), orderBy("dateKey", "desc"), limit(5))
          : query(col, where("clientName", "==", name), orderBy("dateKey", "desc"), limit(5));
        const snap5 = await getDocs(fiveQuery);
        if (dead) return;
        const fiveDocs = [];
        snap5.forEach(doc => fiveDocs.push({ id: doc.id, ...doc.data() }));
        setLast(fiveDocs);
      } finally {
        if (!dead) setLoading(false);
      }
    })();
    return () => { dead = true; };
  }, [phone, name]);

  // --- Statistika (booked / cancelled / no-show)
  const stats = useMemo(() => {
    const s = { total: 0, booked: 0, cancelled: 0, noShow: 0 };
    const svcByEmp = new Map();

    for (const a of rows) {
      s.total += 1;
      const st = (a.status || "booked").toLowerCase();
      if (st.includes("cancel")) s.cancelled += 1;
      else if (st.includes("no")) s.noShow += 1;
      else s.booked += 1;

      const items = Array.isArray(a.servicesInfo) && a.servicesInfo.length
        ? a.servicesInfo
        : (a.serviceName ? [{ name: a.serviceName }] : []);

      const emp = a.employeeName || "—";
      for (const it of items) {
        const svc = it?.name || a.serviceName || "Usluga";
        const key = `${svc}__${emp}`;
        svcByEmp.set(key, (svcByEmp.get(key) || 0) + 1);
      }
    }

    const grouped = new Map();
    for (const [k, c] of svcByEmp.entries()) {
      const [svc, emp] = k.split("__");
      if (!grouped.has(svc)) grouped.set(svc, new Map());
      grouped.get(svc).set(emp, (grouped.get(svc).get(emp) || 0) + c);
    }
    return { summary: s, grouped };
  }, [rows]);

  const serviceTable = useMemo(() => {
    const allEmps = new Set();
    for (const [, empMap] of stats.grouped.entries()) {
      for (const emp of empMap.keys()) allEmps.add(emp);
    }
    const empCols = Array.from(allEmps).sort((a,b) => a.localeCompare(b,"sr"));

    const data = Array.from(stats.grouped.entries()).map(([svc, empMap]) => {
      const row = { service: svc, total: 0 };
      for (const emp of empCols) {
        const cnt = empMap.get(emp) || 0;
        row[emp] = cnt;
        row.total += cnt;
      }
      return row;
    }).sort((a,b) => b.total - a.total);

    return { empCols, data };
  }, [stats.grouped]);

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.card} onClick={e => e.stopPropagation()}>
        <div style={styles.header}>
          <div style={{fontWeight:900, fontSize:18}}>
            Klijent: {name || "—"} {phone ? `(${phone})` : ""}
          </div>
          <button onClick={onClose} style={styles.closeBtn} aria-label="Zatvori">✕</button>
        </div>

        {loading ? (
          <div style={{padding:"16px 0"}}>Učitavanje…</div>
        ) : (
          <>
            {/* --- Statistika --- */}
            <div style={styles.summaryGrid}>
              <div style={styles.sumBox}>
                <div style={styles.sumLabel}>Ukupno termina</div>
                <div style={styles.sumValue}>{stats.summary.total}</div>
              </div>
              <div style={styles.sumBox}>
                <div style={styles.sumLabel}>Aktivno/realizovano</div>
                <div style={styles.sumValue}>{stats.summary.booked}</div>
              </div>
              <div style={styles.sumBox}>
                <div style={styles.sumLabel}>Otkazano</div>
                <div style={styles.sumValue}>{stats.summary.cancelled}</div>
              </div>
              <div style={styles.sumBox}>
                <div style={styles.sumLabel}>No-show</div>
                <div style={styles.sumValue}>{stats.summary.noShow}</div>
              </div>
            </div>

            {/* --- Tabela --- */}
            <div style={{marginTop:12}}>
              <div style={{fontWeight:900, marginBottom:8}}>Usluge po radnicama</div>
              {serviceTable.data.length === 0 ? (
                <div style={{opacity:.8}}>Nema istorije usluga.</div>
              ) : (
                <div style={{overflowX:"auto"}}>
                  <table style={styles.table}>
                    <thead>
                      <tr>
                        <th style={styles.th} align="left">Usluga</th>
                        {serviceTable.empCols.map(emp => (
                          <th key={emp} style={styles.th}>{emp}</th>
                        ))}
                        <th style={styles.th}>Ukupno</th>
                      </tr>
                    </thead>
                    <tbody>
                      {serviceTable.data.map((row, i) => (
                        <tr key={i} style={i%2?styles.trAlt:undefined}>
                          <td style={styles.tdLeft}>{row.service}</td>
                          {serviceTable.empCols.map(emp => (
                            <td key={emp} style={styles.td}>{row[emp] || 0}</td>
                          ))}
                          <td style={styles.td}><b>{row.total}</b></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* --- Poslednjih 5 termina --- */}
            <div style={{marginTop:16}}>
              <details open>
                <summary style={{cursor:"pointer", fontWeight:700}}>
                  Poslednjih 5 termina
                </summary>
                <div style={{marginTop:8, maxHeight:240, overflow:"auto"}}>
                  {last.map(r => (
                    <div key={r.id} style={styles.rowItem}>
                      <div>
                        <b>{r.dateKey || "—"}</b>{" "}
                        <span style={{opacity:.8}}>
                          {(r.startHHMM || "")}{r.endHHMM ? `–${r.endHHMM}` : ""} • {r.employeeName || "—"}
                        </span>
                      </div>
                      <div style={{opacity:.9}}>
                        {(Array.isArray(r.servicesInfo) && r.servicesInfo.length
                          ? r.servicesInfo.map(s=>s.name).join(", ")
                          : (r.serviceName || "Usluga")
                        )}
                      </div>
                      <div style={{opacity:.7}}>status: {r.status || "booked"}</div>
                    </div>
                  ))}
                </div>
              </details>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- Stilovi ---------- */
const styles = {
  backdrop: {
    position:"fixed", inset:0, background:"rgba(0,0,0,.35)",
    display:"flex", alignItems:"center", justifyContent:"center", zIndex:9999,
    padding:12,
  },
  card: {
    width:"min(880px, 100%)",
    maxHeight:"90vh",
    overflow:"auto",
    borderRadius:16,
    background:"linear-gradient(180deg, rgba(255,255,255,.92), rgba(255,255,255,.85))",
    boxShadow:"0 12px 48px rgba(0,0,0,.25)",
    padding:16,
  },
  header: {
    display:"flex", alignItems:"center", justifyContent:"space-between",
    position:"sticky", top:0, background:"transparent", paddingBottom:4,
  },
  closeBtn: {
    border:"1px solid #ddd6cc", background:"#fff", borderRadius:10,
    padding:"6px 10px", fontWeight:800, cursor:"pointer",
  },
  summaryGrid: {
    display:"grid",
    gridTemplateColumns:"repeat(4, minmax(0,1fr))",
    gap:8,
  },
  sumBox: {
    border:"1px solid rgba(0,0,0,.08)",
    background:"#fff", borderRadius:12, padding:"10px 12px",
  },
  sumLabel: { fontSize:12, opacity:.75 },
  sumValue: { fontSize:20, fontWeight:900, marginTop:2 },
  table: { width:"100%", borderCollapse:"separate", borderSpacing:0 },
  th: {
    background:"#f7f4ef",
    position:"sticky", top:0,
    fontWeight:800, borderBottom:"1px solid #e7e0d8",
    padding:"8px 10px", whiteSpace:"nowrap",
  },
  trAlt: { background:"#faf8f6" },
  td: { textAlign:"center", padding:"8px 10px", borderBottom:"1px solid #f0ece6" },
  tdLeft: { textAlign:"left", padding:"8px 10px", borderBottom:"1px solid #f0ece6" },
  rowItem: {
    border:"1px solid #eee3d8",
    background:"#fff",
    borderRadius:10,
    padding:"8px 10px",
    marginBottom:8,
  },
};
