@echo off
echo Downloading 720p HD (MP4) locally...
yt-dlp -f "bestvideo[height<=720]+bestaudio/best[height<=720]" --merge-output-format mp4 "https://www.youtube.com/watch?v=N6_0bXUTFME"
pause
