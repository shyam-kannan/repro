// Holds quantities in the page and asks the server to price the cart.
// Quantity, unit price and total are rendered together from one response.
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const field = (name) => document.querySelector(`[data-field="${name}"]`);
const increaseButton = document.querySelector('[data-action="increase"]');

let quantities = { mug: 1 };

async function update(next) {
  increaseButton.disabled = true;
  try {
    const response = await fetch('/api/cart/price', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: Object.entries(next).map(([id, quantity]) => ({ id, quantity })) }),
    });
    if (!response.ok) throw new Error(`Pricing failed (${response.status})`);
    const cart = await response.json();
    quantities = next;
    const line = cart.lines[0];
    field('unit-price').textContent = money.format(line.unitPriceCents / 100);
    field('quantity').textContent = String(line.quantity);
    field('total').textContent = money.format(cart.totalCents / 100);
    field('error').hidden = true;
  } catch {
    field('error').textContent = 'Sorry, the cart could not be updated.';
    field('error').hidden = false;
  } finally {
    increaseButton.disabled = false;
  }
}

increaseButton.addEventListener('click', () => update({ mug: quantities.mug + 1 }));
update(quantities);
