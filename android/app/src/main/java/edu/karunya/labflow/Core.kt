package edu.karunya.labflow

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import com.google.android.gms.tasks.Tasks
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Locale
import java.util.concurrent.TimeUnit

/** What the app keeps on the phone: server addresses, the LABFLOW sign-in, the linked phone and unsent reports. */
class Store(ctx: Context) {
    private val p = ctx.applicationContext.getSharedPreferences("labflow", Context.MODE_PRIVATE)
    private fun str(k: String, def: String? = null) = p.getString(k, def)
    private fun put(k: String, v: String?) = p.edit().putString(k, v).apply()

    var api: String get() = str("api", BuildConfig.API_URL)!!; set(v) = put("api", v)
    var web: String get() = str("web", BuildConfig.WEB_URL)!!; set(v) = put("web", v)
    var session: String? get() = str("session"); set(v) = put("session", v)
    var credentialId: String? get() = str("cred"); set(v) = put("cred", v)
    var name: String? get() = str("name"); set(v) = put("name", v)
    var rollNo: String? get() = str("roll"); set(v) = put("roll", v)
    var deviceStatus: String? get() = str("devstatus"); set(v) = put("devstatus", v)
    /** The session being tracked: sessionId, title, endsAt, pingSeconds. */
    var tracking: JSONObject? get() = str("tracking")?.let { JSONObject(it) }; set(v) = put("tracking", v?.toString())
    /** A fingerprint check waiting for an answer: bioId, message, deadline. */
    var challenge: JSONObject? get() = str("challenge")?.let { JSONObject(it) }; set(v) = put("challenge", v?.toString())

    /** Report numbers only go up, so the server can spot a report sent twice. */
    @Synchronized fun nextSeq(): Long { val n = p.getLong("seq", 0) + 1; p.edit().putLong("seq", n).commit(); return n }
    @Synchronized fun queue(): JSONArray = JSONArray(str("queue", "[]"))
    @Synchronized fun enqueue(o: JSONObject) { val q = queue(); q.put(o); p.edit().putString("queue", q.toString()).commit() }
    @Synchronized fun dropFirst(n: Int) {
        val q = queue(); val rest = JSONArray()
        for (i in n until q.length()) rest.put(q.get(i))
        p.edit().putString("queue", rest.toString()).commit()
    }
    fun signOut() { val a = api; val w = web; p.edit().clear().commit(); api = a; web = w }
}

class ApiError(val code: String, message: String) : Exception(message)

/** The LABFLOW JSON API: POST {action, payload, session} as text/plain, exactly like the web app. */
object Api {
    fun call(store: Store, action: String, payload: JSONObject, session: String? = store.session): JSONObject {
        val body = JSONObject().put("action", action).put("payload", payload)
        if (session != null) body.put("session", session)
        var conn = (URL(store.api).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"; doOutput = true; instanceFollowRedirects = false
            connectTimeout = 15000; readTimeout = 45000
            setRequestProperty("Content-Type", "text/plain;charset=utf-8")
        }
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
        var code = conn.responseCode
        var hops = 0
        // Apps Script answers a POST with a redirect to the result, which is fetched with GET.
        while (code in 301..308 && hops++ < 5) {
            val next = conn.getHeaderField("Location"); conn.disconnect()
            conn = (URL(next).openConnection() as HttpURLConnection).apply { instanceFollowRedirects = false; connectTimeout = 15000; readTimeout = 45000 }
            code = conn.responseCode
        }
        val text = (if (code < 400) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        conn.disconnect()
        val json = try { JSONObject(text) } catch (e: Exception) { throw ApiError("NETWORK", "The server answered $code.") }
        if (json.optBoolean("ok")) return json.optJSONObject("data") ?: JSONObject()
        val err = json.optJSONObject("error")
        throw ApiError(err?.optString("code") ?: "ERROR", err?.optString("message") ?: "The request failed.")
    }
}

/**
 * Two P-256 keys in the Android Keystore; the private halves never leave the phone.
 *  DEVICE signs every check-in and presence report.
 *  BIO can only be used right after a strong biometric (fingerprint). A PIN or pattern cannot unlock it, and enrolling a
 *  new fingerprint destroys it, so a valid signature from it means the enrolled fingerprint was given on this phone.
 */
object Keys {
    const val DEVICE = "labflow.device"
    const val BIO = "labflow.bio"
    private fun ks() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun exist() = ks().let { it.containsAlias(DEVICE) && it.containsAlias(BIO) }
    fun reset() { ks().apply { deleteEntry(DEVICE); deleteEntry(BIO) } }
    fun ensure() {
        val ks = ks()
        if (!ks.containsAlias(DEVICE)) make(DEVICE, false)
        if (!ks.containsAlias(BIO)) make(BIO, true)
    }
    private fun make(alias: String, bio: Boolean) {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
        if (bio) spec.setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            .setInvalidatedByBiometricEnrollment(true)
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply { initialize(spec.build()) }.generateKeyPair()
    }

    /** Raw 65-byte public point (the last 65 bytes of the X.509 encoding), base64url, as the server stores it. */
    fun publicKey(alias: String): String { val enc = ks().getCertificate(alias).publicKey.encoded; return b64u(enc.copyOfRange(enc.size - 65, enc.size)) }
    fun signer(alias: String): Signature = Signature.getInstance("SHA256withECDSA").apply { initSign(ks().getKey(alias, null) as PrivateKey) }
    fun sign(alias: String, message: String): String = finish(signer(alias), message)
    fun finish(sig: Signature, message: String): String { sig.update(message.toByteArray()); return b64u(raw(sig.sign())) }

    /** DER SEQUENCE { INTEGER r, INTEGER s } -> 64-byte r || s (the WebCrypto form the server verifies). */
    fun raw(der: ByteArray): ByteArray {
        var i = if (der[1].toInt() and 0x80 != 0) 2 + (der[1].toInt() and 0x7f) else 2
        fun int(): ByteArray {
            require(der[i].toInt() == 2) { "bad signature" }
            val len = der[i + 1].toInt() and 0xff
            val v = der.copyOfRange(i + 2, i + 2 + len).dropWhile { it == 0.toByte() }.toByteArray()
            i += 2 + len
            return ByteArray(32 - v.size) + v
        }
        return int() + int()
    }
    fun b64u(b: ByteArray): String = Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}

/** A fresh location reading. Blocking; call it off the main thread. */
object Loc {
    class Fix(val lat: String, val lng: String, val acc: String, val mock: Boolean)

    @SuppressLint("MissingPermission")
    fun current(ctx: Context): Fix? = try {
        val task = LocationServices.getFusedLocationProviderClient(ctx).getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, CancellationTokenSource().token)
        Tasks.await(task, 45, TimeUnit.SECONDS)?.let {
            @Suppress("DEPRECATION")
            val mock = if (Build.VERSION.SDK_INT >= 31) it.isMock else it.isFromMockProvider
            Fix(String.format(Locale.US, "%.7f", it.latitude), String.format(Locale.US, "%.7f", it.longitude), String.format(Locale.US, "%.1f", it.accuracy), mock)
        }
    } catch (e: Exception) { null }

    /** The signed check-in (c1) or presence report (p1). Fields are joined with "|"; no fix = empty fields. */
    fun message(kind: String, a: Any, b: Any, at: Long, f: Fix?) =
        listOf(kind, a, b, at, f?.lat ?: "", f?.lng ?: "", f?.acc ?: "", if (f?.mock == true) 1 else 0).joinToString("|")
}

/** Notifications: the ongoing "tracking is on" one, and the fingerprint check. */
object Notes {
    const val TRACKING_ID = 1
    private const val CHECK_ID = 2

    fun channels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("tracking", "Attendance tracking", NotificationManager.IMPORTANCE_LOW).apply { description = "Shown while LABFLOW confirms you are at the lab" })
        nm.createNotificationChannel(NotificationChannel("checks", "Fingerprint checks", NotificationManager.IMPORTANCE_HIGH).apply { description = "Your teacher's random fingerprint checks"; enableVibration(true) })
    }
    private fun open(ctx: Context, bio: Boolean) = PendingIntent.getActivity(ctx, if (bio) 2 else 1,
        Intent(ctx, MainActivity::class.java).putExtra("bio", bio).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    fun tracking(ctx: Context, title: String): Notification = Notification.Builder(ctx, "tracking")
        .setSmallIcon(android.R.drawable.ic_menu_mylocation)
        .setContentTitle("Attendance tracking is on")
        .setContentText("$title. LABFLOW checks you are at the lab until the session ends.")
        .setOngoing(true).setContentIntent(open(ctx, false)).build()

    fun fingerprint(ctx: Context) {
        val n = Notification.Builder(ctx, "checks")
            .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
            .setContentTitle("Fingerprint check")
            .setContentText("Tap and confirm with your fingerprint within 2 minutes.")
            .setCategory(Notification.CATEGORY_ALARM).setAutoCancel(true).setContentIntent(open(ctx, true)).build()
        try { ctx.getSystemService(NotificationManager::class.java).notify(CHECK_ID, n) } catch (e: SecurityException) { /* notifications not allowed */ }
    }
    fun clearCheck(ctx: Context) = ctx.getSystemService(NotificationManager::class.java).cancel(CHECK_ID)
}

/** Sends queued presence reports, oldest first. Shared by the tracking service and the app screen. */
object Reports {
    /** Returns the server's reply to the last batch, or null when offline (the reports stay queued). */
    fun flush(ctx: Context, store: Store): JSONObject? {
        var last: JSONObject? = null
        while (true) {
            val q = store.queue()
            if (q.length() == 0) return last ?: JSONObject().put("track", store.tracking != null)
            val batch = JSONArray(); for (i in 0 until minOf(q.length(), 200)) batch.put(q.get(i))
            try {
                last = Api.call(store, "app.ping", JSONObject().put("credentialId", store.credentialId).put("pings", batch))
                store.dropFirst(batch.length())
                last.optJSONObject("challenge")?.let { if (store.challenge?.optString("bioId") != it.optString("bioId")) { store.challenge = it; Notes.fingerprint(ctx) } }
            } catch (e: ApiError) {
                if (e.code == "NO_DEVICE" || e.code == "NO_IDENTITY" || e.code == "SESSION_EXPIRED") { store.tracking = null; return null }
                if (e.code == "RATE_LIMITED" || e.code == "INTERNAL") return null
                store.dropFirst(batch.length()) // refused as malformed: do not retry it forever
            } catch (e: Exception) { return null } // offline
        }
    }
}
