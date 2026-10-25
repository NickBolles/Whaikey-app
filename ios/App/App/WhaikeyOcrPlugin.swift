import Foundation
import UIKit
import ImageIO
import Vision
import Capacitor

/**
 * On-device label text recognition for the scan flow (M1 / Track A5).
 *
 * JS: `registerPlugin("WhaikeyOcr").recognizeText({ imageBase64 })` via
 * `src/lib/native/ocr.ts`, which also owns the response contract:
 *
 *   { engine: "vision", lines: [{ text, height, confidence }] }
 *
 * `height` is the line's bounding-box height as a fraction of the image
 * height (Vision's normalized coordinates), so the web side can weight the
 * brand — the largest print on a label — above the small print.
 *
 * Apple Vision ships with iOS: no package, no CocoaPods (the community
 * ML Kit text plugin is CocoaPods-only and this app is SPM-based), no
 * network, no cost. Registered in `AppBridgeViewController.capacitorDidLoad`
 * (SceneDelegate.swift), not by `cap sync`, because it lives in the app target.
 */
@objc(WhaikeyOcrPlugin)
public class WhaikeyOcrPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WhaikeyOcrPlugin"
    public let jsName = "WhaikeyOcr"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "recognizeText", returnType: CAPPluginReturnPromise)
    ]

    /// Longest edge handed to Vision. Label text is large; a 12 MP photo only costs time.
    private let maxEdge: CGFloat = 2048

    @objc func recognizeText(_ call: CAPPluginCall) {
        guard
            let base64 = call.getString("imageBase64"),
            let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
            let image = UIImage(data: data)
        else {
            call.reject("imageBase64 must be a base64-encoded JPEG or PNG", "INVALID_IMAGE")
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let prepared = self.downscaled(image)
            guard let cgImage = prepared.cgImage else {
                call.reject("Could not decode the image", "INVALID_IMAGE")
                return
            }
            let request = VNRecognizeTextRequest { request, error in
                if let error = error {
                    call.reject("Text recognition failed", "OCR_FAILED", error)
                    return
                }
                let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
                call.resolve([
                    "engine": "vision",
                    "lines": WhaikeyOcrPlugin.lines(from: observations),
                ])
            }
            request.recognitionLevel = .accurate
            // Brand names are not dictionary words: correction turns "Laphroaig" into "Laughing".
            request.usesLanguageCorrection = false
            request.minimumTextHeight = 0.012

            let handler = VNImageRequestHandler(
                cgImage: cgImage,
                orientation: CGImagePropertyOrientation(prepared.imageOrientation),
                options: [:]
            )
            do {
                try handler.perform([request])
            } catch {
                call.reject("Text recognition failed", "OCR_FAILED", error)
            }
        }
    }

    /// Top-to-bottom lines with their relative height and confidence; at most 200, like the API accepts.
    static func lines(from observations: [VNRecognizedTextObservation]) -> [[String: Any]] {
        let ordered = observations.sorted { a, b in
            // Vision's origin is bottom-left: a larger maxY is higher on the label.
            if abs(a.boundingBox.maxY - b.boundingBox.maxY) > 0.01 {
                return a.boundingBox.maxY > b.boundingBox.maxY
            }
            return a.boundingBox.minX < b.boundingBox.minX
        }
        var out: [[String: Any]] = []
        for observation in ordered {
            guard let best = observation.topCandidates(1).first else { continue }
            let text = best.string.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            out.append([
                "text": String(text.prefix(300)),
                "height": Double(observation.boundingBox.height),
                "confidence": Double(best.confidence),
            ])
            if out.count >= 200 { break }
        }
        return out
    }

    private func downscaled(_ image: UIImage) -> UIImage {
        let longest = max(image.size.width, image.size.height)
        guard longest > maxEdge else { return image }
        let scale = maxEdge / longest
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        // Drawing bakes the EXIF orientation in, so the result is `.up`.
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }
}

extension CGImagePropertyOrientation {
    init(_ orientation: UIImage.Orientation) {
        switch orientation {
        case .up: self = .up
        case .upMirrored: self = .upMirrored
        case .down: self = .down
        case .downMirrored: self = .downMirrored
        case .left: self = .left
        case .leftMirrored: self = .leftMirrored
        case .right: self = .right
        case .rightMirrored: self = .rightMirrored
        @unknown default: self = .up
        }
    }
}
