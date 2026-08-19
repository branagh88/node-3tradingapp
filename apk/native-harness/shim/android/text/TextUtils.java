package android.text;

/** Desktop shim for the android.text.TextUtils helpers used by CapacitorHttpUrlConnection. */
public class TextUtils {
    public static boolean isEmpty(CharSequence str) {
        return str == null || str.length() == 0;
    }
}