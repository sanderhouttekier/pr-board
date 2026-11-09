// The Windows Credential Manager reader, as a PowerShell script string (SPEC "Secrets" → "Provider chain").
// It reads every generic credential named in $env:PR_BOARD_CRED_REFS (a JSON array) through CredReadW
// and prints one JSON object: { "<ref>": "<base64 of the raw CredentialBlob>" | null }.
// Decoding the blob (UTF-16LE or UTF-8) happens in src/secrets.js, where it is tested.
// Untested on a real Windows machine.

export const WIN_CRED_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PrBoardCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr buffer);
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      if (c.CredentialBlobSize <= 0 || c.CredentialBlob == IntPtr.Zero) return null;
      byte[] bytes = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, bytes, 0, c.CredentialBlobSize);
      return Convert.ToBase64String(bytes);
    } finally {
      CredFree(p);
    }
  }
}
'@
$refs = ConvertFrom-Json $env:PR_BOARD_CRED_REFS
$out = @{}
foreach ($r in $refs) { $out[[string]$r] = [PrBoardCred]::Read([string]$r) }
[Console]::Out.Write((ConvertTo-Json $out -Compress))
`;

// powershell.exe -EncodedCommand takes base64 of the UTF-16LE script text.
export function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}
