package android.os;

/**
 * Desktop shim for the Android Build class — only the fields/methods used by
 * com.getcapacitor.plugin.http.CapacitorHttpUrlConnection at runtime.
 * SDK_INT is 10 (pre-N) so buildDefaultAcceptLanguageProperty() takes the
 * plain Locale.getDefault() branch (no LocaleList needed on this JVM).
 */
public class Build {
    public static class VERSION {
        public static final int SDK_INT = 10;
    }
    public static class VERSION_CODES {
        public static final int N = 24;
    }
}