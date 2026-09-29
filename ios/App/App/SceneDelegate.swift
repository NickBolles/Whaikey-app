import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = AppBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/**
 * The bridge view controller with iOS's edge-swipe back turned on
 * (docs/STORYBOARD.md §1.1: "the iOS shell enables swipe-back"; review UX-1).
 *
 * Capacitor's config has no key for this, so it is set on the WebView once the
 * bridge has made it. The gesture walks WKWebView's back-forward list, which
 * holds the app router's `pushState` entries, so a swipe is the same step as
 * the header's back button and Android's back key: `popstate`, `router.back()`
 * semantics, client state intact. On the first page of the list it does
 * nothing, which is the right answer — there is nowhere in the app to go.
 */
class AppBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.allowsBackForwardNavigationGestures = true
    }
}
