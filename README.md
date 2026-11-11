# Video Trimmer

Aplikasi desktop (Electron) sederhana untuk memotong video: preview, slider, dan simpan.

## Menjalankan

```
npm install
npm start
```

ffmpeg sudah ikut terpasang lewat `ffmpeg-static`, tidak perlu install terpisah.

## Cara pakai

1. **Buka Video…** atau seret file video ke jendela.
2. Geser pegangan biru di slider (atau putar video lalu tekan **I** / **O**) untuk titik mulai/akhir. Waktu juga bisa diketik.
3. **Simpan Potongan**, pilih lokasi file.

File yang kontainernya tidak bisa diputar Chromium (mis. MPEG-TS hasil download HLS/.m3u8 yang berekstensi `.mp4`, atau AVI/FLV) otomatis di-remux ke MP4 sementara untuk preview, lalu potongannya disimpan sebagai MP4 normal. Proses ini hanya mengganti pembungkus, tanpa encode ulang.

Ekspor tanpa re-encode (`-c copy`): hampir instan dan tanpa penurunan kualitas, tapi potongan jatuh ke keyframe terdekat sehingga awalnya bisa bergeser sedikit.

Pintasan: `Spasi` putar/jeda, `I` set mulai, `O` set akhir, `←/→` atau `J`/`L` mundur/maju 10 dtk (`Shift` + `←/→` = 1 frame).

Catatan: preview memakai pemutar Chromium, jadi codec seperti HEVC/H.265 mungkin tidak bisa di-preview.
