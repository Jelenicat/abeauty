// src/pages/AdminFinansije.jsx
import React, { useEffect, useMemo, useState } from "react";
import { db } from "../firebase";
import {
  addDoc, deleteDoc, doc,
  onSnapshot, query, orderBy, where, collection,
  serverTimestamp, Timestamp
} from "firebase/firestore";

export default function AdminFinansije() {
  // === Mesec (YYYY-MM) ===
  const now = new Date();
  const ymNow = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2, "0")}`;
  const [month, setMonth] = useState(ymNow);

  // === Podaci ===
  const [templates, setTemplates] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [appointments, setAppointments] = useState([]);  // spojen startAt + dateKey
  const [employees, setEmployees] = useState([]);

  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("pregled"); // 'pregled' | 'radnice'
  const [err, setErr] = useState("");

  // --- accordion: otvorene radnice ---
  const [open, setOpen] = useState(() => new Set());
  const toggleOpen = (id) => {
    setOpen(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  // === Forme ===
  const [tplName, setTplName] = useState("");
  const [tplAmount, setTplAmount] = useState("");
  const [expName, setExpName] = useState("");
  const [expAmount, setExpAmount] = useState("");

  // ===== Helpers: granice meseca (Timestamp) =====
  const { startTs, endTs } = useMemo(() => {
    const [Y, M] = month.split("-").map(Number);
    const start = new Date(Y, (M ?? 1) - 1, 1, 0, 0, 0, 0);
    const end = new Date(Y, (M ?? 1), 1, 0, 0, 0, 0); // prvi sledećeg meseca
    return { startTs: Timestamp.fromDate(start), endTs: Timestamp.fromDate(end) };
  }, [month]);

  // String granice (za dateKey "YYYY-MM-DD")
  const { startKey, nextMonthKey } = useMemo(() => {
    const [Y, M] = month.split("-").map(Number);
    const startKey = `${Y}-${String(M).padStart(2,"0")}-01`;
    const next = new Date(Y, (M ?? 1), 1);
    const nextMonthKey = `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,"0")}-01`;
    return { startKey, nextMonthKey };
  }, [month]);

  // ===== Realtime: templates + employees =====
  useEffect(() => {
    const offTpl = onSnapshot(
      query(collection(db, "expenseTemplates"), orderBy("name", "asc")),
      s => setTemplates(s.docs.map(d => ({ id: d.id, ...d.data() })))
    );
    const offEmp = onSnapshot(
      query(collection(db, "employees"), orderBy("name", "asc")),
      s => setEmployees(s.docs.map(d => ({ id: d.id, ...d.data() })))
    );
    return () => { offTpl(); offEmp(); };
  }, []);

  // ===== Realtime: expenses + appointments (startAt || dateKey) =====
  useEffect(() => {
    setLoading(true);

    // monthly expenses
    const offExp = onSnapshot(
      query(collection(db, "expenses"), where("month", "==", month)),
      s => setExpenses(s.docs.map(d => ({ id: d.id, ...d.data() })))
    );

    // appointments: dva listen-a, pa spojimo (dedupe po id)
    let startAtArr = [];
    let dateKeyArr = [];

    const combine = () => {
      const map = new Map();
      for (const a of startAtArr) map.set(a.id, a);
      for (const a of dateKeyArr) map.set(a.id, a);
      setAppointments(Array.from(map.values()));
      setLoading(false);
    };

    const offA = onSnapshot(
      query(
        collection(db, "appointments"),
        where("startAt", ">=", startTs),
        where("startAt", "<", endTs)
      ),
      s => { startAtArr = s.docs.map(d => ({ id: d.id, ...d.data() })); combine(); },
      _err => { startAtArr = []; combine(); }
    );

    const offB = onSnapshot(
      query(
        collection(db, "appointments"),
        where("dateKey", ">=", startKey),
        where("dateKey", "<", nextMonthKey)
      ),
      s => { dateKeyArr = s.docs.map(d => ({ id: d.id, ...d.data() })); combine(); },
      _err => { dateKeyArr = []; combine(); }
    );

    return () => { offExp(); offA(); offB(); };
  }, [month, startTs, endTs, startKey, nextMonthKey]);

  // ===== Izračuni =====
  const costsSum = useMemo(
    () => expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0),
    [expenses]
  );

  // izbaci otkazane
  const monthAppointments = useMemo(() => {
    return appointments.filter(a => {
      const st = (a.status || "").toString().toLowerCase();
      return st !== "canceled" && st !== "otkazano";
    });
  }, [appointments]);

  const revenue = useMemo(() => {
    return monthAppointments.reduce((sum, a) => {
      const v = Number(a.finalPrice ?? a.price ?? a.basePrice ?? 0);
      return sum + (isFinite(v) ? v : 0);
    }, 0);
  }, [monthAppointments]);

  const net = useMemo(() => revenue - costsSum, [revenue, costsSum]);

  // --- zarada po radnici
  const earningsByEmployee = useMemo(() => {
    const m = new Map();
    for (const a of monthAppointments) {
      const eid = a.employeeId || "unknown";
      const v = Number(a.finalPrice ?? a.price ?? a.basePrice ?? 0);
      m.set(eid, (m.get(eid) || 0) + (isFinite(v) ? v : 0));
    }
    const list = [];
    for (const [eid, total] of m) {
      const emp = employees.find(e => e.id === eid);
      list.push({ employeeId: eid, name: emp?.name || "Bez imena", total });
    }
    list.sort((a,b)=> b.total - a.total || a.name.localeCompare(b.name));
    return list;
  }, [monthAppointments, employees]);

  // --- termini grupisani po radnici (+ sortirani)
  const apptsByEmployee = useMemo(() => {
    const m = new Map();
    const norm = (a) => {
      // datum
      const d = a.dateKey || (a.startAt?.toDate
        ? a.startAt.toDate().toISOString().slice(0,10)
        : "");
      // vreme
      const sh = a.startHHMM || (a.startAt?.toDate
        ? a.startAt.toDate().toTimeString().slice(0,5)
        : "");
      const eh = a.endHHMM || "";
      const price = Number(a.finalPrice ?? a.price ?? a.basePrice ?? 0);
      return { ...a, _dateKey: d, _sh: sh, _eh: eh, _amount: price };
    };
    for (const a of monthAppointments) {
      const eid = a.employeeId || "unknown";
      if (!m.has(eid)) m.set(eid, []);
      m.get(eid).push(norm(a));
    }
    for (const [eid, arr] of m) {
      arr.sort((x,y) => (x._dateKey||"").localeCompare(y._dateKey||"") || (x._sh||"").localeCompare(y._sh||""));
    }
    return m;
  }, [monthAppointments]);

  // ===== Akcije: troškovi =====
  async function addTemplate(e) {
    e.preventDefault();
    const n = tplName.trim();
    const a = Number(tplAmount);
    if (!n || !isFinite(a) || a <= 0) return setErr("Unesi validan naziv i iznos.");
    try {
      await addDoc(collection(db, "expenseTemplates"), {
        name: n, amount: a, createdAt: serverTimestamp()
      });
      setTplName(""); setTplAmount("");
    } catch (err) {
      console.error(err); setErr("Greška pri dodavanju fiksnog troška.");
    }
  }

  async function applyTemplateToMonth(t) {
    try {
      await addDoc(collection(db, "expenses"), {
        name: t.name, amount: Number(t.amount)||0, month,
        templateId: t.id, createdAt: serverTimestamp()
      });
    } catch (err) { console.error(err); setErr("Greška pri dodavanju u mesec."); }
  }

  async function addExpense(e) {
    e.preventDefault();
    const n = expName.trim();
    const a = Number(expAmount);
    if (!n || !isFinite(a) || a <= 0) return setErr("Unesi validan naziv i iznos.");
    try {
      await addDoc(collection(db, "expenses"), {
        name: n, amount: a, month, createdAt: serverTimestamp()
      });
      setExpName(""); setExpAmount("");
    } catch (err) { console.error(err); setErr("Greška pri dodavanju troška."); }
  }

  async function removeExpense(id) {
    if (!confirm("Obrisati trošak?")) return;
    try { await deleteDoc(doc(db, "expenses", id)); }
    catch (err) { console.error(err); setErr("Greška pri brisanju."); }
  }

  // ===== UI =====
  return (
    <div style={wrap} className="fin-wrap">
      <style>{css}</style>
      <div style={panel} className="fin-panel">
       <div style={header} className="fin-sticky">

          <h2 style={title}>Troškovi i zarada</h2>
          <input
            type="month"
            value={month}
            onChange={e => setMonth(e.target.value)}
            style={monthInp}
            aria-label="Izaberi mesec"
          />
        </div>

        {/* Tabs */}
        <div style={tabs}>
          <button
            onClick={()=>setTab("pregled")}
            className={`fin-tab ${tab==="pregled" ? "active":""}`}
          >Pregled</button>
          <button
            onClick={()=>setTab("radnice")}
            className={`fin-tab ${tab==="radnice" ? "active":""}`}
          >Radnice</button>
        </div>

        {!!err && <div className="fin-error">{err}</div>}

        {tab === "pregled" ? (
          <>
            {/* Kartice sa sumama */}
            <div className="fin-cards">
              <div className="fin-card">
                <div className="fin-card-title">Zarada</div>
                <div className="fin-card-amount">{revenue.toLocaleString()} RSD</div>
              </div>
              <div className="fin-card">
                <div className="fin-card-title">Troškovi</div>
                <div className="fin-card-amount">{costsSum.toLocaleString()} RSD</div>
              </div>
              <div className="fin-card">
                <div className="fin-card-title">Ukupan prihod</div>
                <div className="fin-card-amount">{net.toLocaleString()} RSD</div>
              </div>
            </div>

            <div className="fin-grid">
              {/* FIKSNI TROŠKOVI (šabloni) */}
              <div className="fin-box">
                <div className="fin-box-head">
                  <div className="fin-box-title">Fiksni troškovi</div>
                </div>
                <form onSubmit={addTemplate} className="fin-row">
                  <input
                    className="fin-input"
                    placeholder="Naziv (npr. Kirija)"
                    value={tplName}
                    onChange={e=>setTplName(e.target.value)}
                  />
                  <input
                    className="fin-input"
                    type="number" min="0"
                    placeholder="Iznos (RSD)"
                    value={tplAmount}
                    onChange={e=>setTplAmount(e.target.value)}
                  />
                  <button className="fin-btn">Dodaj</button>
                </form>

                <div className="fin-list">
                  {templates.map(t => (
                    <div className="fin-item" key={t.id}>
                      <div className="fin-item-name">{t.name}</div>
                      <div className="fin-item-right">
                        <div className="fin-item-amount">{Number(t.amount||0).toLocaleString()} RSD</div>
                        <button className="fin-btn ghost" onClick={()=>applyTemplateToMonth(t)}>
                          Dodaj u {month}
                        </button>
                      </div>
                    </div>
                  ))}
                  {!templates.length && <div className="fin-empty">Još nema fiksnih troškova.</div>}
                </div>
              </div>

              {/* TROŠKOVI ZA MESEC */}
              <div className="fin-box">
                <div className="fin-box-head">
                  <div className="fin-box-title">Troškovi za {month}</div>
                </div>
                <form onSubmit={addExpense} className="fin-row">
                  <input
                    className="fin-input"
                    placeholder="Naziv troška"
                    value={expName}
                    onChange={e=>setExpName(e.target.value)}
                  />
                  <input
                    className="fin-input"
                    type="number" min="0"
                    placeholder="Iznos (RSD)"
                    value={expAmount}
                    onChange={e=>setExpAmount(e.target.value)}
                  />
                  <button className="fin-btn">Dodaj</button>
                </form>

                <div className="fin-list">
                  {expenses.map(e => (
                    <div className="fin-item" key={e.id}>
                      <div className="fin-item-name">{e.name}</div>
                      <div className="fin-item-right">
                        <div className="fin-item-amount">{Number(e.amount||0).toLocaleString()} RSD</div>
                        <button className="fin-btn danger" onClick={()=>removeExpense(e.id)}>Obriši</button>
                      </div>
                    </div>
                  ))}
                  {!expenses.length && <div className="fin-empty">Nema troškova za ovaj mesec.</div>}
                </div>
              </div>
            </div>
          </>
        ) : (
          // TAB: RADNICE
          <div className="fin-box">
            <div className="fin-box-head">
              <div className="fin-box-title">Zarada po radnici — {month}</div>
            </div>

            <div className="fin-list">
              {earningsByEmployee.map(r => {
                const isOpen = open.has(r.employeeId);
                const appts = apptsByEmployee.get(r.employeeId) || [];
                return (
                  <div key={r.employeeId} className="fin-emp-wrap">
                    <button
                      className={`fin-item emp ${isOpen ? "open" : ""}`}
                      onClick={() => toggleOpen(r.employeeId)}
                      title="Prikaži termine"
                    >
                      <div className="fin-item-name">{r.name}</div>
                      <div className="fin-item-amount">{r.total.toLocaleString()} RSD</div>
                    </button>

                    {isOpen && (
                      <div className="fin-sublist">
                        {appts.map(a => (
                          <div key={a.id} className="fin-subitem">
                            <div className="fin-sub-main">
                              <div className="fin-sub-line">
                                <b>{a._dateKey || "—"}</b>
                                <span className="dot" />
                                <span>{a._sh}{a._eh ? `–${a._eh}` : ""}</span>
                              </div>
                              <div className="fin-sub-service">{a.serviceName || "Usluga"}</div>
                            </div>
                            <div className="fin-sub-right">
                              <div className="fin-sub-amount">{Number(a._amount||0).toLocaleString()} RSD</div>
                              {a.clientName && <div className="fin-sub-client">{a.clientName}</div>}
                            </div>
                          </div>
                        ))}
                        {!appts.length && <div className="fin-empty">Nema termina.</div>}
                      </div>
                    )}
                  </div>
                );
              })}
              {!earningsByEmployee.length && (
                <div className="fin-empty">Nema termina u ovom mesecu.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ===== STILOVI ===== */
const wrap = {
  minHeight: "100vh",
  background: "url('/slika1.webp') center/cover no-repeat fixed",
  padding: 24,
  display: "flex",
  justifyContent: "center",
  alignItems: "flex-start",
};
const panel = {
  width: "min(1200px, 100%)",
  background: "rgba(255,255,255,.14)",
  border: "1px solid rgba(255,255,255,.35)",
  backdropFilter: "blur(10px)",
  borderRadius: 28,
  boxShadow: "0 24px 60px rgba(0,0,0,.25)",
  padding: "clamp(16px,4vw,28px)",
};
const header = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 };
const title = { margin: 0, color: "#000", fontWeight: 900, fontSize: "clamp(20px,3.2vw,28px)", letterSpacing: .2 };
const monthInp = { height: 40, borderRadius: 12, border: "1px solid #eaeaea", padding: "0 10px", background: "#fff" };
const tabs = { display: "flex", gap: 8, marginBottom: 10 };

const css = `
/* Osnovno */
.fin-wrap, .fin-wrap * { font-family: 'Poppins', system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
.fin-panel { position: relative; }

/* Tabs */
.fin-tab {
  height: 40px; padding: 0 14px; border-radius: 12px; border: 1px solid #e7e7e7;
  background:#fff; font-weight:800; cursor:pointer; color:#222;
  -webkit-appearance:none; appearance:none; outline:none; -webkit-tap-highlight-color:transparent;
}
.fin-tab.active {
  background: linear-gradient(135deg,#ff5fa2,#ff7fb5); color:#fff; border-color: transparent;
}

/* Kartice — sumarni pregled */
.fin-cards {
  display:grid; grid-template-columns: repeat(auto-fit, minmax(200px,1fr));
  gap:10px; margin: 10px 0 14px;
}
.fin-card{
  background:#fff; border:1px solid #f0f0f0; border-radius:18px; padding:14px;
  box-shadow:0 12px 24px rgba(0,0,0,.08);
}
.fin-card-title{ font-size:13px; color:#666; font-weight:700; margin-bottom:6px; }
.fin-card-amount{ font-weight:900; font-size:22px; color:#222; }

/* Grid: levo desno (desktop) */
.fin-grid{ display:grid; grid-template-columns: 1fr 1fr; gap:12px; }
@media (max-width: 900px){ .fin-grid{ grid-template-columns: 1fr; } }

/* Box-evi */
.fin-box{
  background:rgba(255,255,255,.96); border-radius:20px; border:1px solid #efefef;
  box-shadow:0 16px 28px rgba(0,0,0,.10); overflow:hidden;
}
.fin-box-head{
  display:flex; align-items:center; justify-content:space-between; padding:12px 14px;
  background:linear-gradient(135deg,#fafafa,#f5f5f7); border-bottom:1px solid #ececec;
}
.fin-box-title{ font-weight:900; color:#222; letter-spacing:.2px; }

/* Forme u box-u */
.fin-row{
  display:grid; grid-template-columns: 1fr 140px auto;
  gap:8px; padding:12px; border-bottom:1px dashed #eee;
}
@media (max-width: 700px){
  .fin-row{ grid-template-columns: 1fr; }
  .fin-row .fin-btn{ width:100%; }
}
.fin-input{
  height:44px; border-radius:12px; border:1px solid #e7e7e7; padding:0 12px; background:#fff;
  box-shadow:0 6px 12px rgba(0,0,0,.05); font-size:14px;
}
.fin-btn{
  height:44px; border:none; border-radius:12px; font-weight:800; cursor:pointer; padding:0 14px;
  background:linear-gradient(135deg,#ff5fa2,#ff7fb5); color:#fff; box-shadow:0 10px 22px rgba(255,127,181,.35);
  -webkit-appearance:none; appearance:none; outline:none; -webkit-tap-highlight-color:transparent;
}
.fin-btn.ghost{ background:#efefef; color:#222; box-shadow:none; }
.fin-btn.danger{ background:#ff6b6b; }

/* Liste */
.fin-list{ display:grid; gap:8px; padding:12px; }
.fin-item{
  display:flex; align-items:center; justify-content:space-between; gap:10px;
  background:#fff; border:1px solid #f1f1f1; border-radius:14px; padding:12px; box-shadow:0 10px 18px rgba(0,0,0,.06);
}
.fin-item.emp { width:100%; text-align:left; cursor:pointer; }
.fin-item.emp.open { outline:2px solid #ffd3e6; }

.fin-item-name{ font-weight:800; color:#222; }
.fin-item-right{ display:flex; align-items:center; gap:10px; }
.fin-item-amount{ font-weight:900; color:#333; white-space:nowrap; }

/* Sublista termina po radnici */
.fin-sublist{
  display:grid; gap:8px; margin:8px 0 4px 0; padding:8px 10px;
  background:rgba(255,255,255,.6); border:1px dashed #ead7df; border-radius:12px;
}
.fin-subitem{
  display:flex; align-items:center; justify-content:space-between; gap:12px;
  background:#fff; border:1px solid #eee; border-radius:12px; padding:10px 12px;
  box-shadow:0 6px 12px rgba(0,0,0,.05);
}
.fin-sub-main{ display:grid; gap:4px; min-width:0; }
.fin-sub-line{ display:flex; align-items:center; gap:8px; color:#333; flex-wrap:wrap; }
.fin-sub-line .dot{ width:4px; height:4px; border-radius:999px; background:#bbb; }
.fin-sub-service{ font-weight:700; color:#444; overflow:hidden; text-overflow:ellipsis; }
.fin-sub-right{ text-align:right; white-space:nowrap; }
.fin-sub-amount{ font-weight:900; }
.fin-sub-client{ font-size:12px; color:#666; }

.fin-empty{ padding:10px; color:#888; font-size:13px; }
.fin-error{ color:#ff5fa2; font-weight:700; text-align:center; margin:8px 0; }

/* =========================
   MOBILNE DORADЕ
   ========================= */
@media (max-width: 680px){
  /* wrap/panel spacing */
  .fin-wrap { padding: 14px; }
  .fin-panel { border-radius: 22px; }

  /* sticky header: naslov + month + tabs */
  .fin-sticky{ position: sticky; top: 8px; z-index: 5; }
  .fin-sticky + * { margin-top: 8px; }

  /* header unutra */
  .fin-sticky h2 { font-size: 20px !important; }
  .fin-sticky input[type="month"]{
    height: 42px; border-radius: 12px; padding: 0 10px;
  }

  /* tabs kao full width i veća tap meta */
  .fin-tab { flex:1; height: 44px; border-radius: 14px; font-size:14px; }
  .fin-tab + .fin-tab { margin-left: 6px; }
  /* kontejner tabs-a već ima display:flex u JSX; ovo centriranje */
  .fin-panel > div:nth-of-type(2){ display:flex; gap:6px; }

  /* kartice sa sumama — 1 kolona */
  .fin-cards { grid-template-columns: 1fr; gap:8px; }
  .fin-card { padding: 12px; border-radius:16px; }
  .fin-card-amount{ font-size: 20px; }

  /* forme: 1 kolona, full width dugme */
  .fin-row{ grid-template-columns: 1fr; gap:8px; padding:10px; }
  .fin-input{ height: 44px; font-size: 15px; }
  .fin-btn{ height: 44px; width: 100%; border-radius: 14px; }

  /* stavke lista kompaktnije i „klikabilnije” */
  .fin-item{ padding: 12px; border-radius: 14px; }
  .fin-item-right{ gap: 8px; }
  .fin-item-amount{ font-size: 15px; }

  /* sub-items: u dve linije na uskim ekranima */
  .fin-subitem{
    flex-direction: column; align-items: stretch; gap: 8px;
  }
  .fin-sub-right{ text-align: left; }
}

/* veoma uski telefoni */
@media (max-width: 380px){
  .fin-wrap { padding: 10px; }
  .fin-card-amount{ font-size: 18px; }
  .fin-item{ padding: 10px; }
  .fin-subitem{ padding: 10px; }
  .fin-tab{ height: 42px; font-size: 13px; }
}
`;

