package edu.karunya.labflow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec

/** The phone signs in DER; the server verifies 64-byte r || s against the raw 65-byte public point. */
class KeysTest {
    @Test fun derSignaturesBecomeRawAndVerify() {
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val enc = kp.public.encoded
        val point = enc.copyOfRange(enc.size - 65, enc.size)
        assertEquals(4, point[0].toInt())
        // rebuild the key from the raw point only, as the server does
        val pub = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(enc.copyOfRange(0, enc.size - 65) + point))
        repeat(200) { n ->
            val msg = "p1|SES-0123456789AB|$n|1791955200000|10.9334580|76.7429730|12.0|0"
            val der = Signature.getInstance("SHA256withECDSA").apply { initSign(kp.private); update(msg.toByteArray()) }.sign()
            val raw = Keys.raw(der)
            assertEquals(64, raw.size)
            val ok = Signature.getInstance("SHA256withECDSAinP1363Format").apply { initVerify(pub); update(msg.toByteArray()) }.verify(raw)
            assertTrue("signature $n", ok)
            assertTrue(BigInteger(1, raw.copyOfRange(32, 64)).signum() > 0)
        }
    }
}
