// src/components/LoginModal.jsx
import React, { useEffect, useState, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import "./LoginModal.css";

export default function LoginModal({ open, onClose, onSuccess }) {
  const { login } = useAuth();

  const [firstName, setFirstName] = useState("");
  const [lastName,  setLastName]  = useState("");
  const [phone,     setPhone]     = useState("");

  const [touched,   setTouched]   = useState(false);
  const [loading,   setLoading]   = useState(false);

  // Potvrda broja – lep modal unutar kartice
  const [confirmOpen, setConfirmOpen] = useState(false);

  const cardRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) setTimeout(() => cardRef.current?.querySelector("input")?.focus(), 0);
  }, [open]);

  if (!open) return null;

  // ---- validacija / normalizacija ----
  const rawPhone  = String(phone || "").trim();
  const digits    = rawPhone.replace(/\D/g, "");
  const phoneNorm = digits.replace(/^381/, "0"); // +381xx -> 0xx

  const isAdminPhone   = phoneNorm === "0665511005";
  const isAbeautyPhone = phoneNorm === "0000000000";

  // Dozvoljeni opšti obrasci (svi osim admin/abeauty)
  const startsWith06      = /^06/.test(phoneNorm);
  const startsWithPlus38  = /^\+38/.test(rawPhone); // dozvoli +38… unos

  // Dužine: lokalno 8–11 cifara; međunarodno (+38…) najčešće 11–12 cifara
  const baseLenOkLocal = digits.length >= 8 && digits.length <= 11;
  const baseLenOkIntl  = digits.length >= 11 && digits.length <= 12;

  const regularOk =
    (startsWith06 && baseLenOkLocal) ||
    (startsWithPlus38 && baseLenOkIntl);

  const nameOk  = firstName.trim().length >= 2 && lastName.trim().length >= 2;
  const phoneOk = isAdminPhone || isAbeautyPhone || regularOk;
  const canSubmit = nameOk && phoneOk && !loading;

  // Lepo formatiran prikaz broja (za modal potvrde)
  const prettyPhone = (() => {
    if (rawPhone.startsWith("+")) {
      // Npr: +381601234567 -> +381 60 123 4567
      const rp = rawPhone.replace(/\s+/g, "");
      return rp
        .replace(/^(\+\d{2,3})(\d{2})(\d{3})(\d{0,4})$/,
                 (m, c1, a, b, c) => (c ? `${c1} ${a} ${b} ${c}` : `${c1} ${a} ${b}`))
        // fallback ako ne upadne u gornji obrazac
        .replace(/(\+\d{1,3})(\d+)/, (_, c, rest) => `${c} ${rest}`);
    }
    // domaći format 0xx xxx xxxx
    return phoneNorm.replace(/(\d{3})(\d{3})(\d{0,4})/, (m, a, b, c) =>
      c ? `${a} ${b} ${c}` : `${a} ${b}`
    );
  })();

  // --- submit: prvo otvara lep modal za potvrdu (osim za admin/abeauty), pa login ---
  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit) return;

    const skipConfirm = isAdminPhone || isAbeautyPhone;

    if (!skipConfirm && !confirmOpen) {
      setConfirmOpen(true); // otvori lep modal za potvrdu broja
      return;
    }

    // ako je skip ili je potvrđeno – radi login
    setLoading(true);
    try {
      const created = await login({
        firstName: firstName.trim(),
        lastName:  lastName.trim(),
        phone:     phoneNorm,
      });
      onClose?.();
      onSuccess?.(created);
    } catch (err) {
      console.error("Login save failed:", err);
      alert("Trenutno ne možemo da sačuvamo prijavu. Pokušaj ponovo.");
    } finally {
      setLoading(false);
      setConfirmOpen(false);
    }
  };

  // Klik na "Tačno je" u potvrdi
  const confirmYes = (e) => {
    e?.preventDefault?.();
    // ponovo pozovi submit ali ovaj put confirmOpen je true pa ide login
    setConfirmOpen(true);
    setTimeout(() => {
      const fakeEvent = { preventDefault(){} };
      submit(fakeEvent);
    }, 0);
  };

  // Klik na "Ispravi broj"
  const confirmNo = (e) => {
    e?.preventDefault?.();
    setConfirmOpen(false);
    // fokus na input telefona
    setTimeout(() => {
      const input = cardRef.current?.querySelector('input[type="tel"]');
      input?.focus();
    }, 0);
  };

  return (
    <div
      className="lm-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <div className="lm-card" ref={cardRef} role="dialog" aria-modal="true" aria-labelledby="lm-title">
        <button className="lm-close" aria-label="Zatvori" onClick={onClose}>×</button>

        <div className="lm-header">
          <img src="/logo.png" alt="aBeauty" className="lm-logo" />
          <h3 id="lm-title">Popuni podatke da zakažeš termin</h3>
        </div>

        <form className="lm-form" onSubmit={submit} noValidate>
          <label className="lm-field">
            <span>Ime</span>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="npr. Ana"
              autoComplete="given-name"
            />
            {touched && firstName.trim().length < 2 && <em>Unesi bar 2 slova.</em>}
          </label>

          <label className="lm-field">
            <span>Prezime</span>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="npr. Petrović"
              autoComplete="family-name"
            />
            {touched && lastName.trim().length < 2 && <em>Unesi bar 2 slova.</em>}
          </label>

          <label className="lm-field">
            <span>Telefon</span>
            <input
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="npr. 060 123 4567"
              autoComplete="tel"
            />
            {touched && !phoneOk && (
              <em>
                Unesi ispravan broj: mora početi sa <strong>06</strong> ili <strong>+38</strong>
                {" "} (osim za admina i abeauty).
              </em>
            )}
          </label>

          <button className="lm-submit" type="submit" disabled={!canSubmit}>
            {loading ? "Sačuvano" : "Nastavi i zakaži"}
          </button>
        </form>

        {/* Lep modal za potvrdu broja */}
        {confirmOpen && (
          <div className="lm-confirm-wrap" role="alertdialog" aria-labelledby="confirm-title">
            <div className="lm-confirm-card">
              <h4 id="confirm-title">Potvrdi broj telefona</h4>
              <p className="lm-confirm-phone">{prettyPhone}</p>
              <p className="lm-confirm-sub">
                Ako broj <strong>nije</strong> tačan, klikni <em>Ispravi broj</em> i izmeni ga.
              </p>
              <div className="lm-confirm-actions">
                <button className="lm-btn-secondary" onClick={confirmNo} type="button">
                  Ispravi broj
                </button>
                <button className="lm-btn-primary" onClick={confirmYes} type="button">
                  Tačno je
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
