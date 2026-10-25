package com.whaikey.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.ExifInterface
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.ByteArrayInputStream

/**
 * On-device label text recognition for the scan flow (M1 / Track A5).
 *
 * JS: `registerPlugin("WhaikeyOcr").recognizeText({ imageBase64 })` through
 * `src/lib/native/ocr.ts`, which owns the response contract:
 *
 *   { engine: "mlkit", lines: [{ text, height, confidence }] }
 *
 * `height` is the line's bounding-box height as a fraction of the image
 * height, so the web side can weight the brand (the largest print) above the
 * small print. Uses the Google-Play-services ML Kit model
 * (`play-services-mlkit-text-recognition`): free, on-device, and not shipped in
 * the APK — the `com.google.mlkit.vision.DEPENDENCIES` manifest entry asks Play
 * to fetch it at install time. Registered in [MainActivity], not by `cap sync`.
 */
@CapacitorPlugin(name = "WhaikeyOcr")
class WhaikeyOcrPlugin : Plugin() {
    private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

    @PluginMethod
    fun recognizeText(call: PluginCall) {
        val base64 = call.getString("imageBase64")
        if (base64.isNullOrEmpty()) {
            call.reject("imageBase64 must be a base64-encoded JPEG or PNG", "INVALID_IMAGE")
            return
        }
        val bytes = try {
            Base64.decode(base64, Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            call.reject("imageBase64 is not valid base64", "INVALID_IMAGE", e)
            return
        }
        val bitmap = decodeDownscaled(bytes, MAX_EDGE)
        if (bitmap == null) {
            call.reject("Could not decode the image", "INVALID_IMAGE")
            return
        }
        val image = InputImage.fromBitmap(bitmap, exifRotationDegrees(bytes))
        // After rotation the image's height is the bitmap's width for 90/270.
        val rotated = image.rotationDegrees % 180 != 0
        val imageHeight = (if (rotated) bitmap.width else bitmap.height).toDouble().coerceAtLeast(1.0)

        recognizer.process(image)
            .addOnSuccessListener { text ->
                val result = JSObject()
                result.put("engine", "mlkit")
                result.put("lines", linesOf(text, imageHeight))
                call.resolve(result)
            }
            .addOnFailureListener { e ->
                // Most often the Play-services model is still downloading on first use.
                call.reject("Text recognition failed", "OCR_FAILED", e)
            }
    }

    private fun linesOf(text: Text, imageHeight: Double): JSArray {
        val lines = text.textBlocks
            .flatMap { it.lines }
            .sortedWith(compareBy({ it.boundingBox?.top ?: 0 }, { it.boundingBox?.left ?: 0 }))
        val out = JSArray()
        for (line in lines) {
            val value = line.text.trim()
            if (value.isEmpty()) continue
            val obj = JSObject()
            obj.put("text", value.take(300))
            line.boundingBox?.let { obj.put("height", (it.height() / imageHeight).coerceIn(0.0, 1.0)) }
            obj.put("confidence", line.confidence.toDouble().coerceIn(0.0, 1.0))
            out.put(obj)
            if (out.length() >= 200) break
        }
        return out
    }

    private fun decodeDownscaled(bytes: ByteArray, maxEdge: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxEdge) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
    }

    private fun exifRotationDegrees(bytes: ByteArray): Int = try {
        when (ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(
            ExifInterface.TAG_ORIENTATION,
            ExifInterface.ORIENTATION_NORMAL,
        )) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90
            ExifInterface.ORIENTATION_ROTATE_180 -> 180
            ExifInterface.ORIENTATION_ROTATE_270 -> 270
            else -> 0
        }
    } catch (e: Exception) {
        0
    }

    companion object {
        /** Longest edge handed to ML Kit; label text is large and a 12 MP photo only costs time. */
        private const val MAX_EDGE = 2048
    }
}
