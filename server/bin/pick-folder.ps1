# The folder picker behind the board's + tab. Prints the chosen folder, or nothing on cancel.
#
# Windows' Explorer-style picker (IFileOpenDialog in folder mode), not WinForms' FolderBrowserDialog.
# PowerShell 5.1 runs .NET Framework, whose FolderBrowserDialog is the old tree-only "Browse For
# Folder" box, and the owner asked for "a file explorer where i can select a folder". Canon 02
# revision 11.
#
# Run it with -STA: the dialog is COM and needs a single-threaded apartment.

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace GardenPick {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  class FileOpenDialogCoClass {}

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  // IFileOpenDialog's vtable up to GetResult, in declaration order (IModalWindow, then IFileDialog).
  // Nothing past GetResult is called, so nothing past it is declared.
  [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
  }

  public static class Picker {
    const uint FOS_PICKFOLDERS = 0x20;
    const uint FOS_FORCEFILESYSTEM = 0x40;
    const uint SIGDN_FILESYSPATH = 0x80058000;

    // Null when he cancels. Anything else going wrong throws, so it is reported rather than read
    // as a cancel.
    public static string Pick(IntPtr owner, string title) {
      var dialog = (IFileOpenDialog)new FileOpenDialogCoClass();
      try {
        uint options;
        dialog.GetOptions(out options);
        dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
        dialog.SetTitle(title);
        dialog.SetOkButtonLabel("Open in Garden");
        int hr = dialog.Show(owner);
        if (hr == unchecked((int)0x800704C7)) return null; // ERROR_CANCELLED
        Marshal.ThrowExceptionForHR(hr);
        IShellItem item;
        dialog.GetResult(out item);
        string path;
        item.GetDisplayName(SIGDN_FILESYSPATH, out path);
        return path;
      } finally {
        Marshal.ReleaseComObject(dialog);
      }
    }
  }
}
'@

# Owned by an always-on-top window of this process, so the dialog is always-on-top too and sits above
# the browser whether or not Windows lets it have the focus. Measured on the owner's board after his
# click on +: the raise helper's HWND_TOPMOST, sent from another process, returned true and left the
# dialog not topmost, under Garden ("when i press plus it goes behind garden"). Canon 02 revision 16.
#
# The owner window is the one with the taskbar button, titled like the dialog, so there is still
# something to find it by (the old owner form had none: "its hidden behind garden"). It is invisible
# and sits at the centre of the screen the pointer is on. Never owned by the browser, which would
# make it modal to the browser and leave the browser disabled if this process were killed. The raise
# helper in project.pick (server/src/index.ts) still centres the dialog and asks for the focus.
Add-Type -AssemblyName System.Windows.Forms
$title = 'Pick a project folder for Garden'
$area = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position).WorkingArea
$owner = New-Object System.Windows.Forms.Form
$owner.Text = $title
$owner.TopMost = $true
$owner.ShowInTaskbar = $true
$owner.FormBorderStyle = 'None'
$owner.Opacity = 0
$owner.StartPosition = 'Manual'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Location = New-Object System.Drawing.Point(($area.X + [int]($area.Width / 2)), ($area.Y + [int]($area.Height / 2)))
$owner.Show()
try {
  $picked = [GardenPick.Picker]::Pick($owner.Handle, $title)
} finally {
  $owner.Close()
}
if ($picked) { Write-Output $picked }
