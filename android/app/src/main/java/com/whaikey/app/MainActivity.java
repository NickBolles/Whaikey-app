package com.whaikey.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-target plugins are not discovered by `cap sync`; register them
        // before the bridge starts. On-device label OCR (src/lib/native/ocr.ts).
        registerPlugin(WhaikeyOcrPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
