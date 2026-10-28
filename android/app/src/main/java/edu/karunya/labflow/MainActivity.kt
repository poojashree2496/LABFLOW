package edu.karunya.labflow

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.net.Uri
import android.os.Bundle
import android.os.CancellationSignal
import android.os.PowerManager
import android.provider.Settings
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
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
 * checks, and set up permissions and battery. Plain framework views styled like the website, so the app has no UI
 * libraries to keep up to date.
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
        box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(16), dp(16), dp(32)) }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setBackgroundColor(PAPER); fitsSystemWindows = true
            addView(header()); addView(ScrollView(context).apply { addView(box); layoutParams = LinearLayout.LayoutParams(-1, 0, 1f) })
        })
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
    // The website's look (styles/input.css): Karunya blue header with a gold rule, white cards on a cool paper
    // background, blue primary buttons. Plain framework views drawn with GradientDrawable.
    private val BRAND = 0xFF143D8F.toInt(); private val DEEP = 0xFF0B2A66.toInt(); private val GOLD = 0xFFE0A30D.toInt()
    private val PAPER = 0xFFF3F6FB.toInt(); private val INK = 0xFF0F1B33.toInt(); private val SOFT = 0xFF4F5D78.toInt()
    private val LINE = 0xFFC3CDE0.toInt(); private val HAIR = 0xFFE1E7F1.toInt(); private val ACCENT_SOFT = 0xFFE4ECFB.toInt()
    private val GOOD = 0xFF1C8A55.toInt(); private val GOOD_SOFT = 0xFFDEF4E8.toInt(); private val WARN = 0xFF8A5A10.toInt(); private val WARN_SOFT = 0xFFFDF1D8.toInt()
    private val BAD = 0xFFC53030.toInt()
    private val MEDIUM: Typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun shape(fill: Int, radius: Int, stroke: Int? = null) = GradientDrawable().apply {
        setColor(fill); cornerRadius = dp(radius).toFloat(); if (stroke != null) setStroke(dp(1), stroke)
    }
    private fun ripple(fill: Int, radius: Int, stroke: Int? = null) = RippleDrawable(ColorStateList.valueOf(0x33143D8F), shape(fill, radius, stroke), null)
    private fun lp(top: Int = 0, h: Int = -2) = LinearLayout.LayoutParams(-1, h).apply { topMargin = dp(top) }
    private fun text(s: String, size: Float = 16f, bold: Boolean = false, top: Int = 8, color: Int = INK) = TextView(this).apply {
        text = s; textSize = size; setTextColor(color); setLineSpacing(0f, 1.15f)
        if (bold) typeface = MEDIUM
        layoutParams = lp(top)
    }
    private fun button(label: String, primary: Boolean = false, top: Int = 10, onClick: () -> Unit) = Button(this).apply {
        text = label; isAllCaps = false; textSize = 16f; stateListAnimator = null; typeface = MEDIUM
        setTextColor(if (primary) Color.WHITE else BRAND)
        background = if (primary) ripple(BRAND, 8) else ripple(Color.WHITE, 8, LINE)
        layoutParams = lp(top, dp(52))
        setOnClickListener { if (!busy) onClick() }
    }
    private fun card(fill: Int, stroke: Int, top: Int, vararg kids: View?) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; background = shape(fill, 12, stroke); elevation = dp(1).toFloat()
        setPadding(dp(16), dp(14), dp(16), dp(16)); layoutParams = lp(top)
        kids.forEach { if (it != null) addView(it) }
    }
    private fun badge(s: String, fg: Int, bg: Int) = TextView(this).apply {
        text = s; textSize = 13f; setTextColor(fg); typeface = MEDIUM
        background = shape(bg, 999); setPadding(dp(10), dp(3), dp(10), dp(4))
        layoutParams = LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(10) }
    }
    private fun section(s: String) = text(s.uppercase(), 12f, true, 26, SOFT).apply { letterSpacing = 0.08f }
    /** A tappable row in a settings list, with a chevron. */
    private fun row(label: String, color: Int = INK, onClick: () -> Unit) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = dp(52)
        setPadding(dp(16), 0, dp(12), 0); background = RippleDrawable(ColorStateList.valueOf(0x22143D8F), ColorDrawable(Color.WHITE), null)
        addView(TextView(context).apply { text = label; textSize = 16f; setTextColor(color); layoutParams = LinearLayout.LayoutParams(0, -2, 1f) })
        addView(TextView(context).apply { text = "›"; textSize = 22f; setTextColor(LINE) })
        setOnClickListener { if (!busy) onClick() }
    }
    private fun list(vararg rows: View) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; background = shape(Color.WHITE, 12, HAIR); clipToOutline = true; elevation = dp(1).toFloat(); layoutParams = lp(8)
        rows.forEachIndexed { i, r ->
            if (i > 0) addView(View(context).apply { setBackgroundColor(HAIR); layoutParams = LinearLayout.LayoutParams(-1, dp(1)).apply { marginStart = dp(16) } })
            addView(r)
        }
    }
    private fun header() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setBackgroundColor(BRAND)
        addView(LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(20), dp(16), dp(20), dp(16))
            addView(ImageView(context).apply {
                setImageResource(R.drawable.emblem); background = shape(Color.WHITE, 10); setPadding(dp(3), dp(3), dp(3), dp(3))
                layoutParams = LinearLayout.LayoutParams(dp(48), dp(48)); contentDescription = "Karunya"
            })
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL; setPadding(dp(14), 0, 0, 0)
                addView(TextView(context).apply { text = "LABFLOW"; textSize = 26f; setTextColor(Color.WHITE); letterSpacing = 0.04f; typeface = Typeface.create("sans-serif-condensed", Typeface.BOLD) })
                addView(TextView(context).apply { text = "Karunya lab attendance"; textSize = 13f; setTextColor(0xCCFFFFFF.toInt()) })
            })
        })
        addView(View(context).apply { setBackgroundColor(GOLD); layoutParams = LinearLayout.LayoutParams(-1, dp(3)) })
    }
    private fun say(msg: String) = runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_LONG).show() }
    private fun ui(fn: () -> Unit) = runOnUiThread(fn)

    private fun render() {
        box.removeAllViews()
        if (store.session == null) return renderWelcome()
        val linked = store.deviceStatus == "active"
        box.addView(card(Color.WHITE, HAIR, 0,
            text(store.name ?: "", 20f, true, 0),
            text(store.rollNo ?: "", 14f, top = 2, color = SOFT),
            if (linked) badge("Phone linked to you", GOOD, GOOD_SOFT) else badge("Waiting for teacher approval", WARN, WARN_SOFT),
            if (linked) null else text("Until your teacher approves this phone, your check-ins are flagged for review.", 14f, top = 8, color = SOFT)))
        val t = store.tracking
        box.addView(if (t != null) card(GOOD_SOFT, 0xFFB5E3C9.toInt(), 12,
                text("Attendance tracking is on", 18f, true, 0, GOOD),
                text("${t.optString("title")}. The app reports your location every few minutes until the session ends, also with the screen locked. Leave it running.", 14f, top = 6))
            else card(ACCENT_SOFT, 0xFFC9D7F2.toInt(), 12,
                text("Not checked in", 18f, true, 0, DEEP),
                text("In the lab, scan the check-in code on the lab screen or your teacher's screen.", 14f, top = 6, color = SOFT)))
        store.challenge?.let { if (it.optLong("deadline") > System.currentTimeMillis()) box.addView(button("Answer the fingerprint check", primary = true, top = 16) { askFingerprint() }) }
        box.addView(button("Check in: scan the lab screen", primary = t == null, top = 16) { scan("in") })
        box.addView(button("Check out: scan the lab screen", primary = t != null) { scan("out") })
        box.addView(section("Setup"))
        box.addView(list(row("Location permission") { needLocation {} }, row("Keep LABFLOW running (battery)") { battery() },
            row("Server settings") { serverSettings() }, row("Unlink this phone", BAD) { unlink() }))
    }

    private fun renderWelcome() {
        fun step(n: Int, s: String) = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; layoutParams = lp(12)
            addView(TextView(context).apply { text = "$n"; textSize = 13f; gravity = Gravity.CENTER; setTextColor(Color.WHITE); typeface = Typeface.DEFAULT_BOLD; background = shape(BRAND, 999); layoutParams = LinearLayout.LayoutParams(dp(26), dp(26)) })
            addView(TextView(context).apply { text = s; textSize = 15f; setTextColor(INK); setPadding(dp(12), dp(2), 0, 0) })
        }
        box.addView(card(Color.WHITE, HAIR, 0,
            text("Lab attendance for Karunya", 20f, true, 0),
            text("This app confirms you are in the lab for the whole session, not only when you check in.", 15f, top = 6, color = SOFT),
            step(1, "Sign in to LABFLOW with your college account."), step(2, "Your phone is linked to you: one phone per student."), step(3, "In the lab, scan the code on the screen to check in.")))
        if (!canFingerprint()) box.addView(card(WARN_SOFT, 0xFFF0D9A6.toInt(), 12, text("Set up a fingerprint first", 16f, true, 0, WARN),
            text("Open your phone's Settings and add a fingerprint. LABFLOW asks for it during the session to make sure it is you, not just your phone.", 14f, top = 4)))
        box.addView(button("Sign in to link this phone", primary = true, top = 16) {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(store.web + (if (store.web.contains("?")) "&" else "?") + "pairApp=1")))
        })
        box.addView(button("Scan a link code shown on a laptop") {
            GmsBarcodeScanning.getClient(this, GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()).startScan()
                .addOnSuccessListener { b -> val u = Uri.parse(b.rawValue ?: ""); if (u.scheme == "labflow" && u.host == "pair") u.getQueryParameter("t")?.let { link(it) } else say("That is not a LABFLOW link code.") }
                .addOnFailureListener { say("Could not scan: ${it.message}") }
        })
        box.addView(section("Setup"))
        box.addView(list(row("Server settings") { serverSettings() }))
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
