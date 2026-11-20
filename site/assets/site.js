// Mobile nav: progressive enhancement. The page works with this script absent.
(function () {
  var t = document.querySelector(".navtoggle");
  var l = document.getElementById("navlinks");
  if (!t || !l) return;
  function close() {
    l.classList.remove("open");
    t.setAttribute("aria-expanded", "false");
  }
  t.addEventListener("click", function () {
    var open = l.classList.toggle("open");
    t.setAttribute("aria-expanded", open ? "true" : "false");
  });
  l.addEventListener("click", function (e) {
    if (e.target.tagName === "A") close();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && l.classList.contains("open")) {
      close();
      t.focus();
    }
  });
  document.addEventListener("click", function (e) {
    if (l.classList.contains("open") && !l.contains(e.target) && !t.contains(e.target)) close();
  });
})();
