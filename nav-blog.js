/* ==========================================================================
   nav-blog.js — Menu mobile partagé du blog
   Chargé par blog.html, en/blog.html et chaque article.
   ========================================================================== */
function ouvrirMenuMobile() {
  var m = document.getElementById('mobile-menu');
  if (!m) return;
  m.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function fermerMenuMobile() {
  var m = document.getElementById('mobile-menu');
  if (!m) return;
  m.classList.remove('open');
  document.body.style.overflow = '';
}
function fermerMenuSiBackdrop(e) {
  if (e.target === e.currentTarget || e.target.classList.contains('mobile-menu-backdrop')) {
    fermerMenuMobile();
  }
}
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') fermerMenuMobile();
});
