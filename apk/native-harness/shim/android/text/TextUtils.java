package android.text;

/** Desktop shim for the android.text.TextUtils helpers used by the real plugin sources. */
public class TextUtils {
    public static boolean isEmpty(CharSequence str) {
        return str == null || str.length() == 0;
    }

    /** Join helper matching android.text.TextUtils.join(String, Iterable). */
    public static String join(CharSequence delimiter, Iterable<?> tokens) {
        StringBuilder sb = new StringBuilder();
        boolean first = true;
        for (Object token : tokens) {
            if (!first) sb.append(delimiter);
            sb.append(token);
            first = false;
        }
        return sb.toString();
    }
}