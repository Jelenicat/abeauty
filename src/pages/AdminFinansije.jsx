// src/pages/AdminFinansije.jsx
import React, { useEffect, useMemo, useState } from "react";
import { db } from "../firebase";
import {
  addDoc, deleteDoc, doc, updateDoc,
  onSnapshot, query, orderBy, where, collection,
  serverTimestamp, Timestamp
} from "firebase/firestore";
import { useNavigate } from "react-router-dom";

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

  const nav = useNavigate();

  // --- accordion: otvorene radnice ---
  const [open, setOpen] = useState(() => new Set());
  const toggleOpen = (id) => {
    setOpen(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  // procenat po radnici (0–100), kljuc = employeeId
  const [commissionByEmp, setCommissionByEmp] = useState({});

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

  // Učitaj početne procente iz employees
  useEffect(() => {
    const map = {};
    for (const e of employees) map[e.id] = Number(e.commissionPct || 0);
    setCommissionByEmp(map);
  }, [employees]);

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

  /* =========================
     HELPER: iznos jednog termina
     - prioritet: finalPrice / price (ručno upisano)
     - inače: zbir iz servicesInfo
     - fallback: basePrice
     ========================= */
  function amountForAppt(a) {
    // 1) uvek poštuj ručno ili finalno upisanu cenu sa termina
    const override = a.finalPrice ?? a.price;
    if (
      override != null &&
      String(override).trim() !== "" &&
      isFinite(Number(override))
    ) {
      return Number(override);
    }

    // 2) ako nema override-a, saberi iz servicesInfo
    if (Array.isArray(a.servicesInfo) && a.servicesInfo.length) {
      return a.servicesInfo.reduce(
        (s, it) => s + Number(it.price ?? it.basePrice ?? 0),
        0
      );
    }

    // 3) fallback
    return Number(a.basePrice ?? 0);
  }

  /* =====================================================
     FALLBACK META O RADNICI — ime iz termina kad je obrisana
     ===================================================== */
  const empIndex = useMemo(() => {
    const m = new Map();
    for (const e of employees) m.set(e.id, e);
    return m;
  }, [employees]);

  function slugifyName(x="") {
    return x.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9\-]/g, "");
  }

  /**
   * Vrati meta-info o radnici za dati termin:
   * - Ako postoji employeeId i radnica u bazi => (id, name iz employees)
   * - Ako postoji employeeId, ali radnica obrisana => (id = employeeId, name iz termina)
   * - Ako nema employeeId, ali u terminu postoji employeeName => synthetic "legacy:<slug>"
   * - U suprotnom => (id="unknown", name="Bez imena")
   */
  function empOfAppointment(a){
    const apptName = (a.employeeName || "").trim();
    const eid = (a.employeeId || "").trim();

    if (eid) {
      const emp = empIndex.get(eid);
      return {
        id: eid,
        name: (emp?.name || apptName || "Bez imena").trim(),
        isReal: !!emp,
        isLegacy: !emp && !!apptName
      };
    }

    if (apptName) {
      return {
        id: `legacy:${slugifyName(apptName)}`,
        name: apptName,
        isReal: false,
        isLegacy: true
      };
    }

    return { id: "unknown", name: "Bez imena", isReal: false, isLegacy: false };
  }

  /* =========================
     DEDUPE HELPERI — spreči duple termine u obračunu
     (koristi empOfAppointment da bismo imali stabilan ključ i za legacy)
     ========================= */
  function normStr(x) {
    return String(x || "").trim().toLowerCase();
  }
  function onlyDigits(x) {
    return String(x || "").replace(/\D/g, "");
  }
  function extractDateAndTime(a) {
    const dateKey =
      a.dateKey ||
      (a.startAt?.toDate ? a.startAt.toDate().toISOString().slice(0, 10) : "");
    const startHHMM =
      a.startHHMM ||
      (a.startAt?.toDate ? a.startAt.toDate().toTimeString().slice(0, 5) : "");
    return { dateKey, startHHMM };
  }
  function serviceKeyOf(a) {
    if (Array.isArray(a.servicesInfo) && a.servicesInfo.length) {
      const names = a.servicesInfo
        .map(s => normStr(s?.name || ""))
        .filter(Boolean)
        .sort();
      return names.join(",");
    }
    return normStr(a.serviceName || "usluga");
  }
  function clientKeyOf(a) {
    const phone = onlyDigits(a.clientPhone);
    if (phone) return `p:${phone}`;
    const name = normStr(a.clientName);
    return name ? `n:${name}` : "unknown";
  }
  function dedupeKey(a) {
    const { dateKey, startHHMM } = extractDateAndTime(a);
    const emp = empOfAppointment(a).id || "unknown";
    return [emp, dateKey, startHHMM, clientKeyOf(a), serviceKeyOf(a)].join("|");
  }
  function dedupeAppointments(arr = []) {
    const seen = new Set();
    const out = [];
    for (const a of arr) {
      const k = dedupeKey(a);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(a);
      }
    }
    return out;
  }

  // ===== Izračuni =====
  const costsSum = useMemo(
    () => expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0),
    [expenses]
  );

  // samo termini/usluge koji se računaju u prihod/zaradu
  const monthAppointments = useMemo(() => {
    const NON_REVENUE_TYPES = new Set(["break", "pause", "odmor", "smena", "block", "blokada", "vacation", "shift"]);
    const EXCLUDED_STATUSES = new Set([
      "canceled", "cancelled", "otkazano", "otkazan",
      "no-show", "noshow", "no show"
    ]);

    return appointments.filter(a => {
      const st = String(a.status || "").toLowerCase().trim();
      const tp = String(a.type || "").toLowerCase().trim();

      if (EXCLUDED_STATUSES.has(st)) return false;   // otkazani & no-show ne ulaze
      if (NON_REVENUE_TYPES.has(tp))  return false;  // odmori/smene/blokade van prihoda

      // stariji zapisi bez type-a tretiraju se kao usluga
      return !tp || tp === "booking" || tp === "termin" || tp === "service";
    });
  }, [appointments]);

  // ⚠️ DEDUPE: isti (radnica + datum + vreme + klijent + usluga) računa se kao jedan
  const monthAppointmentsDeduped = useMemo(() => {
    return dedupeAppointments(monthAppointments);
  }, [monthAppointments, empIndex]); // zavisi i od empIndex jer dedupeKey koristi empOfAppointment

  // ukupni prihod (bruto)
  const revenue = useMemo(() => {
    return monthAppointmentsDeduped.reduce((sum, a) => {
      const v = amountForAppt(a);
      return sum + (isFinite(v) ? v : 0);
    }, 0);
  }, [monthAppointmentsDeduped]);

  const net = useMemo(() => revenue - costsSum, [revenue, costsSum]);

  // --- zarada po radnici (bruto po radnici) sa fallback imenom iz termina
  const earningsByEmployee = useMemo(() => {
    const m = new Map(); // key=emp.id, value={ total, name, isReal, isLegacy }
    for (const a of monthAppointmentsDeduped) {
      const emp = empOfAppointment(a);
      const v = amountForAppt(a);
      const cur = m.get(emp.id) || { total: 0, name: emp.name, isReal: emp.isReal, isLegacy: emp.isLegacy };
      cur.total += (isFinite(v) ? v : 0);
      if (!cur.name && emp.name) cur.name = emp.name;
      cur.isReal = cur.isReal || emp.isReal;
      cur.isLegacy = cur.isLegacy || emp.isLegacy;
      m.set(emp.id, cur);
    }
    const list = Array.from(m.entries()).map(([employeeId, v]) => ({
      employeeId,
      name: v.name || "Bez imena",
      total: v.total,
      isReal: v.isReal,
      isLegacy: v.isLegacy
    }));
    list.sort((a,b)=> b.total - a.total || a.name.localeCompare(b.name));
    return list;
  }, [monthAppointmentsDeduped, empIndex]);

  // --- termini grupisani po radnici (+ sortirani) + tačne cene i imena svih usluga
  const apptsByEmployee = useMemo(() => {
    const m = new Map();
    const norm = (a) => {
      const d = a.dateKey || (a.startAt?.toDate
        ? a.startAt.toDate().toISOString().slice(0,10)
        : "");
      const sh = a.startHHMM || (a.startAt?.toDate
        ? a.startAt.toDate().toTimeString().slice(0,5)
        : "");
      const eh = a.endHHMM || "";
      const price = amountForAppt(a);

      // prikaz naziva više usluga, ako postoje
      const serviceNames = Array.isArray(a.servicesInfo) && a.servicesInfo.length
        ? a.servicesInfo.map(s => s.name).join(", ")
        : (a.serviceName || "Usluga");

      const emp = empOfAppointment(a);

      return {
        ...a,
        _dateKey: d, _sh: sh, _eh: eh, _amount: price, _serviceNames: serviceNames,
        _empId: emp.id, _empName: emp.name, _empIsReal: emp.isReal, _empIsLegacy: emp.isLegacy
      };
    };
    for (const a of monthAppointmentsDeduped) {
      const na = norm(a);
      if (!m.has(na._empId)) m.set(na._empId, []);
      m.get(na._empId).push(na);
    }
    for (const [eid, arr] of m) {
      arr.sort((x,y) => (x._dateKey||"").localeCompare(y._dateKey||"") || (x._sh||"").localeCompare(y._sh||""));
    }
    return m;
  }, [monthAppointmentsDeduped, empIndex]);

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

  // ===== Procenat po radnici: helperi =====
  const setCommissionPct = (empId, v) => {
    const num = Math.max(0, Math.min(100, Number(v)));
    setCommissionByEmp(prev => ({ ...prev, [empId]: num }));
  };

  async function saveCommissionPct(empId) {
    try {
      const pct = Number(commissionByEmp[empId] || 0);
      // ako radnica ne postoji u employees (ili je legacy/unknown), preskoči
      const exists = employees.some(e => e.id === empId);
      if (!exists) return;
      await updateDoc(doc(db, "employees", empId), {
        commissionPct: pct,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.error(err);
      setErr("Greška pri čuvanju procenta.");
    }
  }

  // ===== UI =====
  return (
    <div style={wrap} className="fin-wrap">
      <style>{css}</style>
      <div style={panel} className="fin-panel">
        {/* FIXED HEADER: Nazad + month input (uvek fiksiran gore) */}
        <div className="fin-fixed fin-header">
          <button
            onClick={() => nav(-1)}
            className="fin-back"
            aria-label="Nazad na prethodnu stranu"
          >
            ← Nazad
          </button>

          <input
            type="month"
            value={month}
            onChange={e => setMonth(e.target.value)}
            style={monthInp}
            className="fin-month"
            aria-label="Izaberi mesec"
          />
        </div>
        {/* Spacer da sadržaj ne uleti ispod fiksiranog bara */}
        <div className="fin-fixed-spacer" />

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
                const isRealEmp = !!r.isReal;
                const isLegacy  = !!r.isLegacy;

                const handleKeyToggle = (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleOpen(r.employeeId);
                  }
                };

                const pct = Number(commissionByEmp[r.employeeId] ?? 0);
                const payout = Math.round((r.total || 0) * (pct / 100));

                return (
                  <div key={r.employeeId} className="fin-emp-wrap">
                    {/* Klikabilna traka (div kao button, da bi input radio) */}
                    <div
                      className={`fin-item emp ${isOpen ? "open" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleOpen(r.employeeId)}
                      onKeyDown={handleKeyToggle}
                      title="Prikaži termine"
                    >
                      <div className="fin-item-name">
                        {r.name}
                        {!isRealEmp && (
                          <span title="Radnica ne postoji u employees (ime iz termina)" style={{marginLeft:8, fontSize:12, color:"#999"}}>
                            • iz termina
                          </span>
                        )}
                      </div>

                      <div className="fin-item-right">
                        {/* Ukupna zarada */}
                        <div className="fin-item-amount">{r.total.toLocaleString()} RSD</div>

                        {/* Kontrole za procenat + izračun (samo ako postoji u employees) */}
                        {isRealEmp && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}
                          >
                            <input
                              type="number"
                              min="0"
                              max="100"
                              placeholder="%"
                              className="fin-input"
                              style={{ width: 96, height: 36, padding: "0 8px" }}
                              value={commissionByEmp[r.employeeId] ?? ""}
                              onChange={(e) => setCommissionPct(r.employeeId, e.target.value)}
                            />
                            <button
                              className="fin-btn ghost"
                              onClick={() => saveCommissionPct(r.employeeId)}
                              title="Sačuvaj procenat"
                            >
                              Sačuvaj %
                            </button>
                            <div className="fin-item-amount" title="Isplata radnici prema procentu">
                              {payout.toLocaleString()} RSD
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Sublista termina */}
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
                              <div className="fin-sub-service">{a._serviceNames}</div>
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
const monthInp = { height: 40, borderRadius: 12, border: "1px solid #eaeaea", padding: "0 10px", background: "#fff" };
const tabs = { display: "flex", gap: 8, marginBottom: 10 };

const css = `
/* Osnovno */
.fin-wrap, .fin-wrap * { font-family: 'Poppins', system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
.fin-panel { position: relative; }

/* FIXED header (desktop + mobilni) */
.fin-fixed {
  position: fixed;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  width: min(1200px, calc(100% - 32px));
  z-index: 20;

  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0;
  background: none;
  border: none;
  box-shadow: none;
  backdrop-filter: none;
}

.fin-fixed-spacer{
  height: 64px;
  margin-bottom: 10px;
}

/* Header layout tweaks za uže ekrane */
.fin-header { justify-content: space-between; }
@media (max-width: 680px){
  .fin-header { flex-direction: column; align-items: stretch; }
  .fin-fixed-spacer{ height: 96px; }
}

/* Nazad dugme */
.fin-back{
  height: 40px;
  padding: 0 14px;
  border: none;
  border-radius: 12px;
  font-weight: 900;
  cursor: pointer;
  background: linear-gradient(135deg,#ff5fa2,#ff7fb5);
  color: #fff;
  box-shadow: 0 10px 22px rgba(255,127,181,.35);
  -webkit-appearance:none; appearance:none; outline:none; -webkit-tap-highlight-color:transparent;
}
.fin-back:active{ transform: translateY(1px); }

/* Month input stilizacija */
.fin-month{
  color:#222;
  background:#fff;
  border:1px solid #eaeaea;
  border-radius:12px;
  height:40px;
  padding:0 10px;
  outline:none;
  box-shadow: 0 6px 12px rgba(0,0,0,.05);
}
.fin-month:focus{
  border-color:#ff9cbc;
  box-shadow:0 0 0 3px rgba(255,127,181,.25);
}
.fin-month::-webkit-datetime-edit,
.fin-month::-webkit-datetime-edit-text,
.fin-month::-webkit-datetime-edit-month-field,
.fin-month::-webkit-datetime-edit-year-field {
  color:#222;
}
.fin-month::-webkit-calendar-picker-indicator{
  opacity:.75;
  filter: grayscale(100%);
}

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
.fin-btn.ghost{ background:#efefef; color:#222; box-shadow:none; white-space:nowrap; }
.fin-btn.danger{ background:#ff6b6b; }

/* Liste */
.fin-list{ display:grid; gap:8px; padding:12px; }
.fin-item{
  display:flex; align-items:flex-start; justify-content:space-between; gap:10px;
  background:#fff; border:1px solid #f1f1f1; border-radius:14px; padding:12px; box-shadow:0 10px 18px rgba(0,0,0,.06);
}
.fin-item.emp { width:100%; text-align:left; cursor:pointer; }
.fin-item.emp.open { outline:2px solid #ffd3e6; }

.fin-item-name{ font-weight:800; color:#222; flex:1; min-width:160px; word-break:break-word; }
.fin-item-right{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:flex-end; }
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
   MOBILNE DORADE
   ========================= */
@media (max-width: 680px){
  .fin-wrap { padding: 14px; }
  .fin-panel { border-radius: 22px; }

  /* fixed header - veći tap i raspored */
  .fin-back { height: 44px; border-radius: 14px; }
  .fin-month{ height: 44px; }

  /* tabs kao full width i veća tap meta */
  .fin-tab { flex:1; height: 44px; border-radius: 14px; font-size:14px; }
  .fin-tab + .fin-tab { margin-left: 6px; }
  .fin-panel > div:nth-of-type(3){ display:flex; gap:6px; }

  /* kartice sa sumama — 1 kolona */
  .fin-cards { grid-template-columns: 1fr; gap:8px; }
  .fin-card { padding: 12px; border-radius:16px; }
  .fin-card-amount{ font-size: 20px; }

  /* forme: 1 kolona, full width dugme */
  .fin-row{ grid-template-columns: 1fr; gap:8px; padding:10px; }
  .fin-input{ height: 44px; font-size: 15px; }
  .fin-btn{ height: 44px; width: 100%; border-radius: 14px; }

  /* liste i podliste */
  .fin-item{ flex-direction: column; align-items: stretch; gap: 8px; }
  .fin-item-right{ justify-content: space-between; gap: 8px; }
  .fin-subitem{ flex-direction: column; align-items: stretch; gap: 8px; }
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
