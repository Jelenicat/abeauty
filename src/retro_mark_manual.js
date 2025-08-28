// retro_mark_manual.js
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";

admin.initializeApp({
  credential: admin.credential.cert("./serviceAccountKey.json"),
});

const db = getFirestore();

// === PODESAVANJE ===
const DRY_RUN = false;                // true = samo ispis (ne piše u bazu)
const MODE = "bookingOnly";           // "bookingOnly" (preporučeno) ili "all"
const BATCH_SIZE = 450;               // Firestore limit 500

// Ako želiš dodatnu heuristiku (npr. nema clientPhone):
const EXTRA_FILTER = (data) => true;  // npr: (d) => !d.clientPhone

async function run() {
  console.log(`▶️  Start retro mark (MODE=${MODE}, DRY_RUN=${DRY_RUN})`);

  let snap;
  if (MODE === "bookingOnly") {
    // Uzimamo samo termine tipa "booking" (ne block/shift/vacation/break)
    snap = await db.collection("appointments")
      .where("type", "==", "booking")
      .get();
  } else {
    // OPREZ: sve dokumente iz kolekcije
    snap = await db.collection("appointments").get();
  }

  console.log(`ℹ️  Nađeno dokumenata: ${snap.size}`);

  let toUpdate = [];
  for (const doc of snap.docs) {
    const data = doc.data();

    // preskoči ako već ima manual === true
    if (data.manual === true) continue;

    // dodatna heuristika (ako želiš)
    if (!EXTRA_FILTER(data)) continue;

    toUpdate.push(doc.ref);
  }

  console.log(`📝 Za obeležavanje manual: ${toUpdate.length}`);

  if (DRY_RUN) {
    console.log("🔎 DRY_RUN je uključen — ne pišem u bazu. Prvih 10 ID-jeva:");
    console.log(toUpdate.slice(0, 10).map(r => r.id));
    return;
  }

  // upis u batch-evima
  let done = 0;
  while (done < toUpdate.length) {
    const chunk = toUpdate.slice(done, done + BATCH_SIZE);
    const batch = db.batch();
    chunk.forEach(ref => batch.update(ref, { manual: true }));

    await batch.commit();
    done += chunk.length;
    console.log(`✅ Upisano ${done}/${toUpdate.length}`);
  }

  console.log("🎉 Gotovo!");
}

run().then(() => process.exit()).catch(e => {
  console.error("❌ Greška:", e);
  process.exit(1);
});
