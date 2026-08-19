package android.os;

import java.util.Locale;

/** Desktop shim — only the API used by CapacitorHttpUrlConnection (unused at SDK_INT=10). */
public class LocaleList {
    public static LocaleList getDefault() {
        return new LocaleList();
    }
    public Locale get(int index) {
        return Locale.getDefault();
    }
}