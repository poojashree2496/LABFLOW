package edu.karunya.labflow

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.net.Uri
import android.os.Bundle
import android.os.CancellationSignal
import android.os.PowerManager
import android.provider.Settings
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONObject
import java.net.URLDecoder
import kotlin.concurrent.thread

/**
 * The one screen of the LABFLOW app: link the phone, check in and out by scanning the lab screen, answer fingerprint
 * checks, and set up permissions and battery. Plain framework views, so the app has no UI libraries to keep up to date.
 */
class MainActivity : Activity() {
    private lateinit var store: Store
    private lateinit var box: LinearLayout
    private var afterPermission: (() -> Unit)? = null
    private var busy = false

    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)
        store = Store(this)
        Notes.channels(this)
        box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(28), dp(20), dp(28)) }
        setContentView(ScrollView(this).apply { addView(box) })
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); handle(intent) }

    override fun onResume() {
        super.onResume()
        render()
        if (store.session != null) refresh()
        askFingerprint()
    }

    private fun handle(i: Intent?) {
        val data = i?.data
        if (data?.scheme == "labflow" && data.host == "pair") data.getQueryParameter("t")?.let { link(it) }
    }

    // ---- screen ------------------------------------------------------------------------------------------------
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun text(s: String, size: Float = 16f, bold: Boolean = false, top: Int = 8) = TextView(this).apply {
        text = s; textSize = size; if (bold) setTypeface(typeface, Typeface.BOLD)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(top) }
    }
    private fun button(label: String, primary: Boolean = false, onClick: () -> Unit) = Button(this).apply {
        text = label; isAllCaps = false; textSize = 16f
        if (primary) setTypeface(typeface, Typeface.BOLD)
        layoutParams = LinearLayout.LayoutParams(-1, dp(56)).apply { topMargin = dp(10) }
        setOnClickListener { if (!busy) onClick() }
    }
    private fun say(msg: String) = runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_LONG).show() }
    private fun ui(fn: () -> Unit) = runOnUiThread(fn)

    private fun render() {
        box.removeAllViews()
        box.addView(text("LABFLOW", 28f, true, 0))
        if (store.session == null) return renderWelcome()
        box.addView(text("${store.name ?: ""} · ${store.rollNo ?: ""}", 18f, true, 4))
        val st = store.deviceStatus
        box.addView(text(if (st == "active") "This phone is linked to you." else "This phone is waiting for your teacher's approval. Until then your check-ins are flagged for review.", 15f))
        val t = store.tracking
        if (t != null) {
            box.addView(text("Attendance tracking is on", 20f, true, 24))
            box.addView(text("${t.optString("title")}. The app reports your location every few minutes until the session ends, also with the screen locked. Leave it running.", 15f))
        } else box.addView(text("Not checked in.", 18f, true, 24))
        box.addView(button("Check in: scan the lab screen", primary = t == null) { scan("in") })
        box.addView(button("Check out: scan the lab screen") { scan("out") })
        store.challenge?.let { if (it.optLong("deadline") > System.currentTimeMillis()) box.addView(button("Answer the fingerprint check", primary = true) { askFingerprint() }) }
        box.addView(text("Setup", 20f, true, 28))
        box.addView(button("Location permission") { needLocation {} })
        box.addView(button("Keep LABFLOW running (battery)") { battery() })
        box.addView(button("Server settings") { serverSettings() })
        box.addView(button("Unlink this phone") { unlink() })
    }

    private fun renderWelcome() {
        box.addView(text("Lab attendance for Karunya. This app confirms you are in the lab for the whole session, not only when you check in.", 16f, top = 12))
        box.addView(text("1. Sign in to LABFLOW with your college account.\n2. Your phone is linked to you: one phone per student.\n3. In the lab, scan the code on the screen to check in.", 15f, top = 16))
        if (!canFingerprint()) box.addView(text("Set up a fingerprint in your phone's Settings first. LABFLOW asks for it during the session to make sure it is you, not just your phone.", 15f, true, 16))
        box.addView(button("Sign in to link this phone", primary = true) {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(store.web + (if (store.web.contains("?")) "&" else "?") + "pairApp=1")))
        })
        box.addView(button("Scan a link code shown on a laptop") {
            GmsBarcodeScanning.getClient(this, GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()).startScan()
                .addOnSuccessListener { b -> val u = Uri.parse(b.rawValue ?: ""); if (u.scheme == "labflow" && u.host == "pair") u.getQueryParameter("t")?.let { link(it) } else say("That is not a LABFLOW link code.") }
                .addOnFailureListener { say("Could not scan: ${it.message}") }
        })
        box.addView(button("Server settings") { serverSettings() })
    }

    // ---- linking -----------------------------------------------------------------------------------------------
    private fun canFingerprint() = getSystemService(BiometricManager::class.java).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS

    /** The web page opened labflow://pair?t=<code>. Make (or reuse) the keys, prove both, and get a LABFLOW sign-in. */
    private fun link(token: String) {
        if (!canFingerprint()) return say("Set up a fingerprint in Settings first, then make a new link code.")
        try { Keys.ensure() } catch (e: Exception) { return say("This phone could not create its keys: ${e.message}") }
        fingerprint("Link this phone to LABFLOW", "Confirm with your fingerprint", token) { bioSig ->
            busy = true
            thread {
                try {
                    val r = Api.call(store, "app.link", JSONObject().put("token", token).put("publicKey", Keys.publicKey(Keys.DEVICE)).put("bioPublicKey", Keys.publicKey(Keys.BIO))
                        .put("sig", Keys.sign(Keys.DEVICE, token)).put("bioSig", bioSig).put("label", android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL), session = null)
                    val st = r.getJSONObject("student")
                    store.session = r.getString("session"); store.credentialId = r.getString("credentialId"); store.deviceStatus = r.getString("status")
                    store.name = st.optString("name"); store.rollNo = st.optString("rollNo")
                    say(if (store.deviceStatus == "active") "Phone linked." else "Linked. Your teacher must approve this new phone.")
                    ui { render(); needLocation { battery() } }
                } catch (e: Exception) { say(e.message ?: "Linking failed.") } finally { busy = false }
            }
        }
    }

    private fun unlink() {
        AlertDialog.Builder(this).setTitle("Unlink this phone?").setMessage("The keys on this phone are deleted. Linking a phone again needs your teacher's approval.")
            .setPositiveButton("Unlink") { _, _ -> stopService(Intent(this, TrackingService::class.java)); Keys.reset(); store.signOut(); render() }
            .setNegativeButton("Cancel", null).show()
    }

    /** Server status: link state, and whether a session is being tracked (restarts tracking if Android stopped it). */
    private fun refresh() = thread {
        try {
            val r = Api.call(store, "app.status", JSONObject().put("credentialId", store.credentialId))
            store.deviceStatus = r.getJSONObject("device").optString("status")
            val inside = r.optJSONObject("inside")
            if (inside != null && inside.optBoolean("track")) { if (store.tracking == null) { store.tracking = inside; startTracking() } else startTracking() }
            else if (inside == null) store.tracking = null
            Reports.flush(this, store)
            ui { render() }
        } catch (e: ApiError) {
            if (e.code == "NO_IDENTITY" || e.code == "SESSION_EXPIRED" || e.code == "NO_DEVICE") { store.session = null; say(e.message ?: ""); ui { render() } }
        } catch (e: Exception) { /* offline */ }
    }

    // ---- check-in ----------------------------------------------------------------------------------------------
    private fun scan(purpose: String) = needLocation {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { b -> submit(purpose, kioskCode(b.rawValue ?: "")) }
            .addOnFailureListener { say("Could not scan: ${it.message}") }
    }
    /** The lab screen shows a link ending in ?k=<code>; the code alone also works. */
    private fun kioskCode(raw: String): String = Regex("[?&]k=([^&#]+)").find(raw)?.groupValues?.get(1)?.let { URLDecoder.decode(it, "UTF-8") } ?: raw.trim()

    private fun submit(purpose: String, code: String) {
        busy = true
        say("Checking your location...")
        thread {
            try {
                val m = Loc.message("c1", code, purpose, System.currentTimeMillis(), Loc.current(this))
                val r = Api.call(store, "app.scan", JSONObject().put("credentialId", store.credentialId).put("m", m).put("sig", Keys.sign(Keys.DEVICE, m)))
                val tr = r.optJSONObject("tracking")
                if (purpose == "in" && tr != null && tr.optBoolean("track")) { store.tracking = tr; startTracking() }
                if (purpose == "out") { store.tracking = null; Reports.flush(this, store); stopService(Intent(this, TrackingService::class.java)) }
                val flagged = r.optJSONArray("flagged")
                val what = if (purpose == "in") "Checked in to ${r.optJSONObject("session")?.optString("title") ?: "the session"}." else "Checked out."
                say(if (flagged != null && flagged.length() > 0) "$what Recorded but flagged for your teacher: ${flagged.join(", ").replace("\"", "").replace('_', ' ')}." else what)
                ui { render(); if (purpose == "in") battery(onlyIfNeeded = true) }
            } catch (e: Exception) { say(e.message ?: "Check-in failed.") } finally { busy = false }
        }
    }

    private fun startTracking() = startForegroundService(Intent(this, TrackingService::class.java))

    // ---- fingerprint -------------------------------------------------------------------------------------------
    /** Sign `message` with the fingerprint key. Only a strong biometric unlocks it; there is no PIN button. */
    private fun fingerprint(title: String, subtitle: String, message: String, done: (String) -> Unit) {
        val sig = try { Keys.signer(Keys.BIO) } catch (e: KeyPermanentlyInvalidatedException) {
            return say("Your fingerprints changed, so this phone must be linked again (your teacher approves it). Use Unlink, then sign in.")
        } catch (e: Exception) { return say("Fingerprint key unavailable: ${e.message}") }
        BiometricPrompt.Builder(this).setTitle(title).setSubtitle(subtitle)
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButton("Cancel", mainExecutor) { _, _ -> }
            .build()
            .authenticate(BiometricPrompt.CryptoObject(sig), CancellationSignal(), mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    try { done(Keys.finish(result.cryptoObject?.signature ?: sig, message)) } catch (e: Exception) { say("Could not sign: ${e.message}") }
                }
                override fun onAuthenticationError(code: Int, msg: CharSequence) { say(msg.toString()) }
            })
    }

    /** A random or teacher-called check is waiting: ask now and send the signed answer. */
    private fun askFingerprint() {
        val ch = store.challenge ?: return
        if (store.session == null) return
        fingerprint("Fingerprint check", "Your teacher is confirming you are in the lab", ch.getString("message")) { sig ->
            thread {
                try {
                    val r = Api.call(store, "app.bio", JSONObject().put("credentialId", store.credentialId).put("bioId", ch.getString("bioId")).put("sig", sig))
                    store.challenge = null; Notes.clearCheck(this)
                    say(when (r.optString("outcome")) { "passed" -> "Fingerprint check passed."; "late" -> "Answered too late; your teacher will see a missed check."; else -> "Fingerprint check: " + r.optString("outcome") })
                    ui { render() }
                } catch (e: Exception) { say(e.message ?: "Could not send the answer. Try again.") }
            }
        }
    }

    // ---- permissions and battery -------------------------------------------------------------------------------
    private fun hasLocation() = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** Explain first, then ask. Location is used only from check-in to the end of that session. */
    private fun needLocation(then: () -> Unit) {
        if (hasLocation()) return then()
        AlertDialog.Builder(this).setTitle("Why LABFLOW needs your location")
            .setMessage("To confirm you are in the lab, LABFLOW reads your phone's location when you check in and every few minutes after that, until the session ends. It also works with the screen locked; a notification is shown the whole time.\n\nOnly your distance from the lab is sent and kept, never your exact position. Outside lab sessions LABFLOW does not use your location.\n\nOn the next screen choose \"While using the app\" and \"Precise\". Also allow notifications, so you see fingerprint checks.")
            .setPositiveButton("Continue") { _, _ ->
                afterPermission = then
                requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.POST_NOTIFICATIONS), 1)
            }.setNegativeButton("Not now", null).show()
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, perms, results)
        val next = afterPermission; afterPermission = null
        if (hasLocation()) next?.invoke() else say("Without location LABFLOW cannot confirm you are in the lab. You can still check in; your teacher will review it.")
    }

    /** Android stops background apps to save battery; tracking must be exempt, and some brands need one more switch. */
    private fun battery(onlyIfNeeded: Boolean = false) {
        val exempt = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)
        if (exempt && onlyIfNeeded) return
        AlertDialog.Builder(this).setTitle("Keep LABFLOW running")
            .setMessage((if (exempt) "Battery saving is already off for LABFLOW. " else "Android may stop LABFLOW to save battery, and then your presence reports stop and you can be marked Partial. Tap Allow on the next screen. ") +
                "\n\nOn Xiaomi, Redmi, POCO, Oppo, Realme, Vivo, OnePlus and Samsung phones also open App settings > Battery and choose \"No restrictions\" (or \"Unrestricted\"), and turn on Autostart if you see it. Do not swipe LABFLOW away from recent apps during a session.")
            .setPositiveButton(if (exempt) "OK" else "Allow") { _, _ ->
                if (!exempt) startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            }
            .setNeutralButton("App settings") { _, _ -> startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
            .show()
    }

    private fun serverSettings() {
        val api = EditText(this).apply { setText(store.api); inputType = InputType.TYPE_TEXT_VARIATION_URI; hint = "API (…/exec)" }
        val web = EditText(this).apply { setText(store.web); inputType = InputType.TYPE_TEXT_VARIATION_URI; hint = "Website" }
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), 0); addView(text("API address", 14f)); addView(api); addView(text("Website", 14f)); addView(web) }
        AlertDialog.Builder(this).setTitle("Server settings").setView(form)
            .setPositiveButton("Save") { _, _ -> store.api = api.text.toString().trim(); store.web = web.text.toString().trim(); render() }
            .setNeutralButton("Defaults") { _, _ -> store.api = BuildConfig.API_URL; store.web = BuildConfig.WEB_URL; render() }
            .setNegativeButton("Cancel", null).show()
    }

}
