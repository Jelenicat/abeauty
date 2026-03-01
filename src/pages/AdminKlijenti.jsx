// src/pages/AdminKlijenti.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../firebase";
import {
  collection,
  onSnapshot,
  query,
  orderBy,
  addDoc,
  doc,
  updateDoc,
  serverTimestamp,
  where,
  limit,
  getDocs,       // ⬅️ dodato
} from "firebase/firestore";
import { useNavigate } from "react-router-dom";
import { deleteDoc } from "firebase/firestore";

// (može ostati import ako ga koristiš negde drugde; ovde ga ne koristimo za inline)
// import ClientStatsPrompt from "../partials/ClientStatsPrompt";

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

// helperi
const normText = (s = "") =>
  s.toString().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const digits = (s = "") => s.toString().replace(/[^\d]/g, "");
const EXCLUDE_PHONES = new Set(["0665511005", "0000000000"]);

/* ---------- Normalizacija broja: isto kao u ClientStatsPrompt ---------- */
function toE164OrNull(raw) {
  const d = digits(raw);
  if (!d) return null;
  if (d.startsWith("381")) return "+" + d;
  if (d.startsWith("06")) return "+381" + d.slice(1);
  if (d.startsWith("00")) return "+" + d.slice(2);
  if (String(raw || "").startsWith("+")) return raw;
  return null;
}
function toLocal06(raw) {
  const d = digits(raw);
  if (d.startsWith("381") && d.length >= 11) return "0" + d.slice(3);
  if (d.startsWith("06")) return "0" + d.slice(1);
  return null;
}
function phoneVariants(raw) {
  const set = new Set();
  const trimmed = String(raw || "").trim();
  if (trimmed) set.add(trimmed);
  const e164 = toE164OrNull(trimmed);
  if (e164) set.add(e164);
  const local06 = toLocal06(trimmed);
  if (local06) set.add(local06);
  // bez razmaka i crtica
  for (const v of Array.from(set)) set.add(v.replace(/\s|-/g, ""));
  // Firestore 'in' max 10 stavki:
  return Array.from(set).filter(Boolean).slice(0, 10);
}

/* ====== INLINE PROFIL KLIJENTA (lokalno, bez modala) ====== */
function InlineClientProfile({ name, phone, onClose }) {
  const [last5, setLast5] = useState([]);
  const [loading, setLoading] = useState(true);

  // CACHE → instant pri ponovnom otvaranju
  const cacheRef = useRef({});

  useEffect(() => {
    let dead = false;

    (async () => {
      try {
        const key = phone || name;

        // ⬅️ CACHE HIT
        if (cacheRef.current[key]) {
          setLast5(cacheRef.current[key]);
          setLoading(false);
          return;
        }

        const variants = phoneVariants(phone);
        if (!variants.length && !name) {
          setLast5([]);
          setLoading(false);
          return;
        }

        setLoading(true);

        const col = collection(db, "appointments");
        const q = variants.length
          ? query(
              col,
              where("clientPhone", "in", variants),
              orderBy("dateKey", "desc"),
              limit(5)
            )
          : query(
              col,
              where("clientName", "==", name || ""),
              orderBy("dateKey", "desc"),
              limit(5)
            );

        const snap = await getDocs(q);
        if (dead) return;

        const data = [];
        snap.forEach((d) => data.push({ id: d.id, ...(d.data() || {}) }));

        cacheRef.current[key] = data; // ⬅️ SAVE CACHE
        setLast5(data);
        setLoading(false);
      } catch (e) {
        console.error(e);
        setLoading(false);
      }
    })();

    return () => {
      dead = true;
    };
  }, [name, phone]);

  async function deleteAppointment(apptId) {
    if (!window.confirm("Da li si sigurna da želiš da obrišeš ovaj termin?")) return;

    try {
      await deleteDoc(doc(db, "appointments", apptId));
      setLast5((prev) => prev.filter((a) => a.id !== apptId));
    } catch (e) {
      console.error(e);
      alert("Greška pri brisanju termina.");
    }
  }

  return (
    <div
      style={{
        width: "100%",
        background: "#fff",
        borderRadius: 12,
        boxShadow: "0 8px 18px rgba(0,0,0,.06)",
        border: "1px solid #eee",
        padding: 12,
      }}
    >
      {/* HEADER */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0, fontWeight: 900 }}>
          Klijent: {name} ({phone})
        </h3>
        <button
          onClick={onClose}
          style={{
            border: "none",
            background: "#f4f4f4",
            borderRadius: 999,
            width: 30,
            height: 30,
            cursor: "pointer",
            fontWeight: 800,
          }}
        >
          ×
        </button>
      </div>

      {/* LAST 5 */}
      <div
        style={{
          border: "1px solid #eee",
          borderRadius: 12,
          overflow: "hidden",
          background: "#fff",
          marginTop: 12,
        }}
      >
        <div
          style={{
            padding: "10px 12px",
            fontWeight: 900,
            borderBottom: "1px solid #f0f0f0",
            background: "#fafafa",
          }}
        >
          ▾ Poslednjih 5 termina
        </div>

        <div style={{ maxHeight: 260, overflow: "auto", padding: 12 }}>
          {loading ? (
            <div style={{ color: "#777" }}>Učitavanje…</div>
          ) : last5.length === 0 ? (
            <div style={{ color: "#777" }}>Nema termina.</div>
          ) : (
            last5.map((a, idx) => (
              <div
                key={a.id}
                style={{ padding: "6px 0", borderBottom: "1px solid #f6f6f6" }}
              >
                <div style={{ fontWeight: 800 }}>
                  {a.dateKey || "—"}{" "}
                  <span style={{ opacity: 0.8 }}>
                    {(a.startHHMM || "")}
                    {a.endHHMM ? `–${a.endHHMM}` : ""} • {a.employeeName || "—"}
                  </span>
                </div>

                <div>
                  {Array.isArray(a.servicesInfo) && a.servicesInfo.length
                    ? a.servicesInfo.map((s) => s.name).join(", ")
                    : a.serviceName || "—"}
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div style={{ color: "#777", fontSize: 12 }}>
                    status: {a.status || "—"}
                  </div>

                  {idx === 0 && (
                    <button
                      onClick={() => deleteAppointment(a.id)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "#c00",
                        fontWeight: 800,
                        cursor: "pointer",
                      }}
                    >
                      Obriši
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
function EditorFields({ form, setForm, inputStyle, focusRef }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <label style={{ display: "grid", gap: 6 }}>
        <span style={{ fontWeight: 800 }}>Ime i prezime</span>
        <input
          ref={focusRef}
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          style={inputStyle}
          placeholder="npr. Ana Perić"
        />
      </label>

      <label style={{ display: "grid", gap: 6 }}>
        <span style={{ fontWeight: 800 }}>Telefon (samo cifre)</span>
        <input
          value={form.phone}
          onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          style={inputStyle}
          placeholder="0641234567"
        />
      </label>

      <label style={{ display: "grid", gap: 6 }}>
        <span style={{ fontWeight: 800 }}>Uloga</span>
        <select
          value={form.role}
          onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
          style={inputStyle}
        >
          <option value="client">client</option>
          <option value="employee">employee</option>
        </select>
      </label>
    </div>
  );
}

/* ========================================================== */

export default function AdminKlijenti() {
  const [users, setUsers] = useState([]);
  const [lastByPhone, setLastByPhone] = useState({});
  const [apptOnlyClients, setApptOnlyClients] = useState({});
  const [search, setSearch] = useState("");
  const isMobile = useIsMobile(700);
  const nav = useNavigate();

  // --- dodavanje/izmena ---
  const emptyForm = { uid: null, source: null, name: "", phone: "", role: "client" };
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null); // uid ili "new"
  const [saving, setSaving] = useState(false);

  // --- koji red ima otvoren inline profil ---
  const [statsOpenId, setStatsOpenId] = useState(null);

  const newNameRef = useRef(null);

  useEffect(() => {
    if (editingId === "new") {
      window.scrollTo({ top: 0, behavior: "smooth" });
      setTimeout(() => {
        try {
          newNameRef.current?.focus();
        } catch {}
      }, 180);
    }
  }, [editingId]);

  function splitName(full = "") {
    const p = full.trim().split(/\s+/);
    if (!p.length) return { firstName: "", lastName: "" };
    if (p.length === 1) return { firstName: p[0], lastName: "" };
    return { firstName: p[0], lastName: p.slice(1).join(" ") };
  }

  // ➕ Novi klijent
  function openAdd() {
    setForm({ ...emptyForm });
    setEditingId("new");
  }

  // ✏️ Izmena
  function openEdit(c) {
    setForm({
      uid: c.uid || null,
      source: c.source || null,
      name: c.name || "",
      phone: c.phone || "",
      role: c.role || "client",
    });
    setEditingId(c.uid);
  }

  function closeEditor() {
    setEditingId(null);
    setForm(emptyForm);
  }

  // Klik na ime/📊
  function openStats(c) {
    setStatsOpenId((prev) => (prev === c.uid ? null : c.uid));
  }

  async function saveClient() {
    const name = (form.name || "").trim();
    const ph = digits(form.phone || "");
    if (!name) return alert("Unesi ime i prezime.");
    if (!ph) return alert("Unesi ispravan broj telefona (samo cifre).");

    setSaving(true);
    try {
      const apptOnly =
        form.source === "appointments" || String(form.uid || "").startsWith("appt:");
      const { firstName, lastName } = splitName(name);

      if (!form.uid || apptOnly) {
        await addDoc(collection(db, "users"), {
          firstName,
          lastName,
          phone: ph,
          role: form.role || "client",
          isAdmin: false,
          isFinance: false,
          createdAt: serverTimestamp(),
        });
      } else {
        await updateDoc(doc(db, "users", form.uid), {
          firstName,
          lastName,
          phone: ph,
          role: form.role || "client",
        });
      }
      closeEditor();
    } catch (e) {
      console.error(e);
      alert("Greška pri snimanju.");
    } finally {
      setSaving(false);
    }
  }

  // -------- data: users --------
  useEffect(() => {
    const qUsers = query(collection(db, "users"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(qUsers, (snap) => {
      const list = [];
      snap.forEach((docu) => {
        const d = docu.data() || {};
        const phoneRaw = d.phone || "";
        const phoneDigits = digits(phoneRaw);
        if (EXCLUDE_PHONES.has(phoneDigits)) return;
        list.push({
          uid: docu.id,
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

  // -------- data: appointments --------
  useEffect(() => {
    const qAppts = query(collection(db, "appointments"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(qAppts, (snap) => {
      const lastMap = new Map();
      const apptClientsMap = new Map();

      snap.forEach((docu) => {
        const a = docu.data() || {};
        const phoneRaw = a.clientPhone || "";
        const ph = digits(phoneRaw);
        if (!ph || EXCLUDE_PHONES.has(ph)) return;

        if (!lastMap.has(ph)) {
          lastMap.set(ph, {
            lastService: a.serviceName || "",
            lastDate: a.dateKey || "",
          });
        }

        if (!apptClientsMap.has(ph)) {
          const guessedName =
            a.clientName?.toString().trim() || a.name?.toString().trim() || "—";
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

  // -------- unify & search --------
  const userPhonesSet = useMemo(() => {
    const s = new Set();
    users.forEach((u) => {
      const ph = digits(u.phone);
      if (ph) s.add(ph);
    });
    return s;
  }, [users]);

  const unified = useMemo(() => {
    const base = [...users];
    Object.entries(apptOnlyClients).forEach(([ph, c]) => {
      if (!userPhonesSet.has(ph)) base.push(c);
    });
    return base;
  }, [users, apptOnlyClients, userPhonesSet]);

  const merged = useMemo(() => {
    return unified.map((u) => {
      const info = lastByPhone[digits(u.phone)] || { lastService: "", lastDate: "" };
      return { ...u, ...info };
    });
  }, [unified, lastByPhone]);

  const filtered = useMemo(() => {
    const q = normText(search);
    const qPhone = digits(search);
    if (!q && !qPhone) return merged;
    return merged.filter((c) => {
      const name = normText(c.name);
      const phone = digits(c.phone);
      const m1 = q ? name.includes(q) : false;
      const m2 = qPhone ? phone.includes(qPhone) : false;
      return m1 || m2;
    });
  }, [merged, search]);

  // ---- UI helpers ----
  const inputStyle = {
    height: 40,
    borderRadius: 10,
    border: "1px solid #ddd",
    padding: "0 12px",
    width: "100%",
    background: "#fff",
  };
  const btn = {
    padding: "8px 12px",
    borderRadius: 10,
    border: "1px solid #ddd",
    background: "#fff",
    fontWeight: 800,
    cursor: "pointer",
  };
  const btnPrimary = { ...btn, border: "none", background: "#ff69b4", color: "#fff" };

  

  return (
    <div style={wrap}>
      <style>{css}</style>

      <div style={panel}>
        <button onClick={() => nav(-1)} style={backBtn}>
          ← Nazad
        </button>

        <div style={headRow(isMobile)}>
          <h2 style={title}>Klijenti</h2>
          <div style={searchBox}>
            <input
              style={searchInput(isMobile)}
              placeholder="Pretraga: ime, prezime ili broj"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {!isMobile && (
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button onClick={openAdd} style={backBtn}>
                ➕ Novi klijent
              </button>
            </div>
          )}
        </div>

        {isMobile && (
          <div style={{ marginBottom: 10 }}>
            <button onClick={openAdd} style={backBtn}>
              ➕ Novi klijent
            </button>
          </div>
        )}

        <div
          style={{
            background: "#fff",
            borderRadius: 16,
            padding: isMobile ? 12 : 16,
            boxShadow: "0 10px 24px rgba(0,0,0,.06)",
          }}
        >
          {filtered.length === 0 ? (
            <p style={{ margin: 0, color: "#777" }}>Nema klijenata.</p>
          ) : (
            <div className="clients-table-wrap">
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
                <thead>
                  <tr style={{ background: "#f6f6f6" }}>
                    <th style={th}>Ime</th>
                    <th style={th}>Telefon</th>
                    <th style={th}>Uloga</th>
                    <th style={th}>Poslednja usluga</th>
                    <th style={th}>Datum</th>
                    <th style={th}>Akcija</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((c, i) => (
                    <React.Fragment key={c.uid}>
                      <tr style={i % 2 ? { background: "#fafafa" } : undefined}>
                        <td style={tdBold}>
                          <button
                            onClick={() => openStats(c)}
                            style={{
                              all: "unset",
                              cursor: "pointer",
                              textDecoration: "underline",
                              fontWeight: 900,
                              color: "#222",
                            }}
                            title="Otvori profil klijenta"
                          >
                            {c.name}
                          </button>
                          {c.source === "appointments" ? (
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: 11,
                                fontWeight: 800,
                                color: "#888",
                              }}
                            >
                              (kal.)
                            </span>
                          ) : null}
                        </td>
                        <td style={td}>{c.phone}</td>
                        <td style={td}>{c.role || "client"}</td>
                        <td style={td}>{c.lastService}</td>
                        <td style={td}>{c.lastDate}</td>
                        <td style={td}>
                          <button onClick={() => openStats(c)} style={btn}>
                            Profil
                          </button>
                          <button onClick={() => openEdit(c)} style={{ ...btn, marginTop: 4 }}>
                            Uredi
                          </button>
                        </td>
                      </tr>

                      {editingId === c.uid && (
                        <tr>
                          <td colSpan={6}>
                            <div
                              style={{
                                padding: 12,
                                background: "#f9f9f9",
                                borderRadius: 8,
                                display: "grid",
                                gap: 10,
                              }}
                            >
                              <EditorFields form={form} setForm={setForm} inputStyle={inputStyle} />
                              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                                <button onClick={closeEditor} style={btn}>
                                  Otkaži
                                </button>
                                <button onClick={saveClient} disabled={saving} style={btnPrimary}>
                                  {saving ? "Čuvam..." : "Sačuvaj"}
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}

                      {/* INLINE PROFIL: render tačno ispod reda */}
                      {statsOpenId === c.uid && (
                        <tr>
                          <td colSpan={6} style={{ padding: 0, borderBottom: "none" }}>
                            <div style={{ margin: "8px 12px 16px", overflow: "hidden" }}>
                              <InlineClientProfile
                                name={c.name}
                                phone={c.phone}
                                onClose={() => setStatsOpenId(null)}
                              />
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* MODAL za novog klijenta (ostaje kao pre) */}
        {editingId === "new" && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,.35)",
              display: "flex",
              justifyContent: "center",
              alignItems: "flex-start",
              paddingTop: 60,
              zIndex: 9999,
            }}
            onClick={closeEditor}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(520px, 92vw)",
                background: "#fff",
                borderRadius: 16,
                boxShadow: "0 24px 64px rgba(0,0,0,.25)",
                padding: 16,
              }}
            >
              <h3 style={{ marginTop: 0, marginBottom: 12, fontWeight: 900 }}>Dodaj klijenta</h3>
              <EditorFields
  form={form}
  setForm={setForm}
  inputStyle={inputStyle}
  focusRef={newNameRef}
/>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
                <button onClick={closeEditor} style={btn}>
                  Otkaži
                </button>
                <button onClick={saveClient} style={btnPrimary} disabled={saving}>
                  {saving ? "Čuvam..." : "Sačuvaj"}
                </button>
              </div>
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
  gridTemplateColumns: mobile ? "1fr" : "1fr 320px auto",
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
