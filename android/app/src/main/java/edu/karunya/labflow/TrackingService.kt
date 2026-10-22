package edu.karunya.labflow

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.HandlerThread
import android.os.PowerManager
import org.json.JSONObject

/**
 * Runs from check-in until the session ends: every few minutes it reads the location, signs a report with the device
 * key, queues it and sends the queue. A foreground service (with its notification) keeps going with the screen locked
 * or while other apps are in use; a partial wake lock keeps the timer running when the phone sits idle on a desk.
 */
class TrackingService : Service() {
    private lateinit var store: Store
    private lateinit var thread: HandlerThread
    private lateinit var handler: Handler
    private var wake: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?) = null

    override fun onCreate() {
        super.onCreate()
        store = Store(this)
        Notes.channels(this)
        thread = HandlerThread("labflow-tracking").apply { start() }
        handler = Handler(thread.looper)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val t = store.tracking ?: run { stopSelf(); return START_NOT_STICKY }
        try {
            startForeground(Notes.TRACKING_ID, Notes.tracking(this, t.optString("title", "Lab session")), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } catch (e: Exception) { stopSelf(); return START_NOT_STICKY } // no location permission any more
        if (wake == null) wake = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "labflow:tracking").apply {
            setReferenceCounted(false); acquire(6 * 3600 * 1000L)
        }
        handler.removeCallbacksAndMessages(null)
        handler.post { tick() }
        return START_STICKY
    }

    private fun tick() {
        val t = store.tracking
        if (t == null || System.currentTimeMillis() > t.optLong("endsAt") + 10 * 60000) { store.tracking = null; Reports.flush(this, store); return finish() }
        val now = System.currentTimeMillis()
        val m = Loc.message("p1", t.getString("sessionId"), store.nextSeq(), now, Loc.current(this))
        try { store.enqueue(JSONObject().put("m", m).put("sig", Keys.sign(Keys.DEVICE, m))) } catch (e: Exception) { /* key gone: the server will see no report */ }
        val reply = Reports.flush(this, store)
        if (reply != null && !reply.optBoolean("track", true)) store.tracking = null // checked out, or the session closed
        val next = reply?.optLong("next", 0)?.takeIf { it > 0 } ?: t.optLong("pingSeconds", 120)
        handler.postDelayed({ tick() }, next * 1000L)
    }

    private fun finish() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        thread.quitSafely()
        wake?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }
}
