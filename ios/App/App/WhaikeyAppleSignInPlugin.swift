import Foundation
import UIKit
import AuthenticationServices
import Capacitor

/**
 * Native Sign in with Apple (M3.3; App Store guideline 4.8).
 *
 * JS: `registerPlugin("WhaikeyAppleSignIn").authorize({ nonce })` via
 * `src/lib/native/apple-sign-in.ts`, which owns the contract:
 *
 *   in:  { nonce }  — already SHA-256 hex of the server-minted nonce; Apple
 *                     signs it into the id token's `nonce` claim verbatim.
 *   out: { identityToken, user, givenName?, familyName?, email? }
 *   err: code "canceled" when the person dismisses the sheet, otherwise "failed".
 *
 * Apple only returns the name and email on the first authorization for this
 * app, so they are passed through for Better Auth to store at sign-up.
 *
 * Plain AuthenticationServices: no package, no CocoaPods (this project is SPM),
 * no browser. Needs the `com.apple.developer.applesignin` entitlement
 * (App.entitlements) and the capability on the App ID. Registered in
 * `AppBridgeViewController.capacitorDidLoad` (SceneDelegate.swift), not by
 * `cap sync`, because it lives in the app target.
 */
@objc(WhaikeyAppleSignInPlugin)
public class WhaikeyAppleSignInPlugin: CAPPlugin, CAPBridgedPlugin,
    ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "WhaikeyAppleSignInPlugin"
    public let jsName = "WhaikeyAppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise)
    ]

    /// The call awaiting Apple's answer; one sheet at a time.
    private var pendingCall: CAPPluginCall?
    /// ASAuthorizationController is not retained by the system while it runs.
    private var controller: ASAuthorizationController?

    @objc func authorize(_ call: CAPPluginCall) {
        guard let nonce = call.getString("nonce"), !nonce.isEmpty else {
            call.reject("A nonce is required", "invalid_argument")
            return
        }
        DispatchQueue.main.async {
            if self.pendingCall != nil {
                call.reject("Sign in with Apple is already in progress", "in_progress")
                return
            }
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.fullName, .email]
            request.nonce = nonce

            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.pendingCall = call
            self.controller = controller
            controller.performRequests()
        }
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        if let window = bridge?.viewController?.view.window {
            return window
        }
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        return scene?.windows.first(where: { $0.isKeyWindow }) ?? ASPresentationAnchor()
    }

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard let call = pendingCall else { return }
        finish()
        guard
            let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let tokenData = credential.identityToken,
            let token = String(data: tokenData, encoding: .utf8)
        else {
            call.reject("Apple returned no identity token", "failed")
            return
        }
        var result: [String: Any] = ["identityToken": token, "user": credential.user]
        if let given = credential.fullName?.givenName { result["givenName"] = given }
        if let family = credential.fullName?.familyName { result["familyName"] = family }
        if let email = credential.email { result["email"] = email }
        call.resolve(result)
    }

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        guard let call = pendingCall else { return }
        finish()
        let canceled = (error as? ASAuthorizationError)?.code == .canceled
        call.reject(error.localizedDescription, canceled ? "canceled" : "failed", error)
    }

    private func finish() {
        pendingCall = nil
        controller = nil
    }
}
